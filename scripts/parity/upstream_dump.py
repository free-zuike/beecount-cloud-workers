#!/usr/bin/env python
"""上游 MCP 只读工具的 golden 输出转储器（运行时差分的"上游一侧"）。

在**有 Python 且装好上游依赖**的环境里运行（CI 见 .github/workflows/parity.yml）：

    cd <上游仓库>
    PYTHONPATH=. python <本文件> <输出路径>

本地 `tests/mcp-differential.test.ts` 会用对应夹具跑同样的调用矩阵并逐字段比对。
两侧都不经 HTTP / MCP transport，直接调函数，所以差异只可能来自业务语义。

关于夹具（重要）：
- 上游 1.9.0 没有 Transaction / Category / Account 模型，交易在 `read_tx_projection`
  投影表里，字典在 `user_category_projection` / `user_account_projection` /
  `user_tag_projection`。只读工具读的就是这些投影表，所以直接往投影表里塞数据
  是合法且最短的路径。
- 插行用 `insert()`，按 `model.__table__.columns` 过滤未知键。这样即使上游增加了列，
  也不会因为多传一个字段而 TypeError（宁可少塞一个字段，也不要整脚本崩掉）。
"""
from __future__ import annotations

import os as _os

# 在导入任何 src 模块之前设置，避免上游模块级 `settings = get_settings()` 缓存到默认值
# （例如 registration_enabled 默认 False，会导致 golden 里注册被禁用 → 403，进而 login 等全 401）。
# 仅此一项需在导入前设好；JWT_SECRET/APP_ENV 由 auth golden 块在导入 src.main 前另行设置。
_os.environ["REGISTRATION_ENABLED"] = "true"

import asyncio
import hashlib
import json
import os
import re
import sys
import types
from datetime import datetime, timezone

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

NOW = datetime(2026, 5, 20, 4, 0, 0, tzinfo=timezone.utc)


def insert(db, model, **kw):
    """按表结构裁剪后插入，并立即 flush。

    立即 flush 是必须的：上游模型之间只有 FK 列、没有 relationship()，
    SQLAlchemy 的工作单元不保证 users 先于 ledgers 落库，
    实测 CI 报 `FOREIGN KEY constraint failed`。逐行 flush 让插入顺序等于代码顺序。
    """
    cols = {c.name for c in model.__table__.columns}
    dropped = set(kw) - cols
    row = model(**{k: v for k, v in kw.items() if k in cols})
    db.add(row)
    try:
        db.flush()
    except Exception as exc:
        raise RuntimeError(
            f"插入 {model.__tablename__} 失败（{type(exc).__name__}: {exc}）；"
            f"已提供={sorted(kw)} 被裁掉={sorted(dropped)}"
        ) from exc
    return row, dropped


def main(out_path: str) -> int:
    os.environ.setdefault("SCHEDULER_TIMEZONE", "Asia/Shanghai")
    os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/parity.db")
    # 附件存在磁盘上（config.attachment_storage_dir），导入预览要从这里读字节
    os.environ.setdefault("ATTACHMENT_STORAGE_DIR", "/tmp/parity-attach")

    # 这个脚本**不是**在 workers 仓库里独立运行的：它要导入"上游 Python 仓库"
    # （TNT-Likely/BeeCount-Cloud）里的 src.* 模块。CI 里上游被 checkout 到
    # .parity/upstream 并设为 PYTHONPATH。本地若直接 `python scripts/parity/upstream_dump.py`
    # 而没把上游仓库放到 PYTHONPATH，会 ImportError。这里给一句人话提示，而不是一堆
    # 看不懂的 traceback。
    try:
        from src.database import Base, SessionLocal, engine  # type: ignore
        from src.mcp.tools import read_tools  # type: ignore
        from src.mcp import capability_tools  # type: ignore
        from src.mcp import file_tools  # type: ignore
        from src.mcp import rule_tools  # type: ignore
        from src.mcp import analysis_tools  # type: ignore
        from src.mcp.tools import write_tools  # type: ignore
        from src.models import (  # type: ignore
            AttachmentFile, Ledger, LedgerMember, ReadTxProjection, User, UserAccountProjection,
            UserCategoryProjection, UserTagProjection,
        )
    except ImportError as exc:  # 绝大多数情况是"没把上游仓库放进 PYTHONPATH"
        sys.stderr.write(
            "无法导入 src.* —— 这个脚本需要上游 Python 仓库（TNT-Likely/BeeCount-Cloud）"
            "作为 PYTHONPATH。\n"
            "正确运行方式（CI 见 .github/workflows/parity.yml）：\n"
            "  git clone <上游仓库> /tmp/upstream\n"
            "  cd /tmp/upstream\n"
            "  pip install -r <workers>/scripts/parity/requirements.txt\n"
            "  PYTHONPATH=. DATABASE_URL=sqlite:////tmp/parity.db \\\n"
            "    python <workers>/scripts/parity/upstream_dump.py /tmp/golden.json\n"
            f"原始错误：{type(exc).__name__}: {exc}\n"
        )
        return 2

    Base.metadata.create_all(bind=engine)
    dropped_keys: set[str] = set()

    # 场景夹具抽成函数：主管线与 REST 独立库都会调用同一份种子，保证"上游一侧"
    # 的 read 计算 golden 不被其它 golden 块（如写路径的 manage_tag 往共享 db 插 "MCP" 标签）污染。
    def seed_scenario(db):
        def add(model, **kw):
            row, dropped = insert(db, model, **kw)
            dropped_keys.update(dropped)
            return row
        # ---------------- 夹具（须与 tests/mcp-differential.test.ts 一致） ----------------
        add(User, id="u1", email="u1@example.com", password_hash="x", is_enabled=True)
        add(User, id="u2", email="u2@example.com", password_hash="x", is_enabled=True)

        add(Ledger, id="L1-i", external_id="L1", user_id="u1", name="主账本",
            currency="CNY", month_start_day=1, created_at=NOW)
        add(Ledger, id="L2-i", external_id="L2", user_id="u2", name="共享账本",
            currency="USD", month_start_day=1, created_at=NOW)
        add(LedgerMember, ledger_id="L1-i", user_id="u1", role="owner")
        add(LedgerMember, ledger_id="L2-i", user_id="u1", role="editor")
        add(LedgerMember, ledger_id="L2-i", user_id="u2", role="owner")
        # 空账本：验证空集合/零值/None 的形状（最容易在"没数据"时走偏）
        add(Ledger, id="L3-i", external_id="L3", user_id="u1", name="空账本",
            currency="JPY", month_start_day=25, created_at=NOW)
        add(LedgerMember, ledger_id="L3-i", user_id="u1", role="owner")

        add(UserCategoryProjection, sync_id="c1", ledger_id="L1-i", user_id="u1",
            name="餐饮", kind="expense", sort_order=1, icon="🍜")
        add(UserCategoryProjection, sync_id="c2", ledger_id="L1-i", user_id="u1",
            name="工资", kind="income", sort_order=2)
        add(UserAccountProjection, sync_id="a1", ledger_id="L1-i", user_id="u1",
            name="现金", account_type="cash", currency="CNY", hidden=False)
        # 本地 D1 的 hidden 是 NOT NULL DEFAULT 0（显式 NULL 会被拒），上游可空。
        # 夹具两侧统一用 False/0，null 语义由 capability-tools 单测覆盖。
        add(UserAccountProjection, sync_id="a2", ledger_id="L1-i", user_id="u1",
            name="招行", account_type="bank", currency="CNY", hidden=False)
        add(UserTagProjection, sync_id="g1", ledger_id="L1-i", user_id="u1",
            name="出差", color="#00bcf2")
        add(UserTagProjection, sync_id="g2", ledger_id="L1-i", user_id="u1",
            name="客户", color="#ff9800")

        # 导入预览用的附件：上游附件存在磁盘，读取时会校验 sha256 + size_bytes
        attach_dir = os.environ["ATTACHMENT_STORAGE_DIR"]
        os.makedirs(attach_dir, exist_ok=True)
        # 必须包含 4 个必填字段对应的列（类型/金额/日期/分类），否则 required_complete
        # 不成立、上游与本地都只报 PARSE_MAPPING_INCOMPLETE，拿不到可执行的 plan
        csv_bytes = ("日期,金额,类型,分类,备注\n"
                     "2026-05-16,12.5,支出,餐饮,午饭\n"
                     "2026-05-17,3000,收入,工资,五月工资\n").encode("utf-8-sig")
        csv_path = os.path.join(attach_dir, "seed.csv")
        with open(csv_path, "wb") as fh:
            fh.write(csv_bytes)
        add(AttachmentFile, id="f1", ledger_id="L1-i", user_id="u1",
            attachment_kind="transaction", file_name="seed.csv", mime_type="text/csv",
            size_bytes=len(csv_bytes), sha256=hashlib.sha256(csv_bytes).hexdigest(),
            storage_path=csv_path, created_at=NOW)

        txs = [
            ("t1", "expense", 38.0, "2026-05-02", "c1", "a1", "星巴克", None, "CNY", None),
            ("t2", "expense", 12.5, "2026-05-02", "c1", "a1", "同秒第二笔", None, "CNY", None),
            ("t3", "income", 8000.0, "2026-05-10", "c2", "a2", None, None, "CNY", None),
            ("t4", "expense", 100.0, "2026-05-11", "c1", "a1", None, None, "CNY", None),
            ("t5", "expense", 20.0, "2026-05-12", "c1", "a1", None, None, "CNY", None),
            ("t6", "expense", 7.5, "2026-05-13", None, "a1", None, None, "USD", 1.03),
            ("t7", "expense", 30.0, "2026-05-14", "c1", "a1", None, "出差,客户", "CNY", None),
        ]
        for idx, (sync, kind, amount, day, cat, acc, note, tags, cur, native) in enumerate(txs):
            hour = 3 if day == "2026-05-02" else 2
            add(ReadTxProjection,
                sync_id=sync, ledger_id="L1-i", user_id="u1", tx_type=kind, amount=amount,
                happened_at=datetime.fromisoformat(f"{day}T{hour:02d}:30:00+00:00"),
                note=note, category_sync_id=cat,
                category_name={"c1": "餐饮", "c2": "工资"}.get(cat or ""),
                category_kind={"c1": "expense", "c2": "income"}.get(cat or ""),
                account_sync_id=acc,
                account_name={"a1": "现金", "a2": "招行"}.get(acc or ""),
                tags_csv=tags, currency_code=cur, native_amount=native,
                tx_index=idx, created_by_user_id="u1", source_change_id=1,
                exclude_from_stats=(sync == "t4"), exclude_from_budget=(sync == "t5"))
        db.commit()

    def make_db(path):
        """独立数据库：删旧文件、建表、播种场景，返回 session。

        用于 REST golden：其它 golden 块（写路径的 manage_tag 等）会往共享 db 的
        user_tag_projection / read_tx_projection 里插数据，泄漏进 list_tags / get_ledger_stats，
        造成"golden 有、本地没有"的假分歧。REST 用一份干净、重新播种的 DB 即可避免。
        """
        if os.path.exists(path):
            os.remove(path)
        eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
        @event.listens_for(eng, "connect")
        def _p(dbapi_conn, _):
            c = dbapi_conn.cursor()
            c.execute("PRAGMA foreign_keys=ON")
            c.close()
        Base.metadata.create_all(bind=eng)
        S = sessionmaker(bind=eng, autocommit=False, autoflush=False)
        db = S()
        seed_scenario(db)
        return db

    db = SessionLocal()
    seed_scenario(db)

    # ---------------- 调用矩阵（与 TS 侧逐条对应） ----------------
    # 每条都是一个"同一夹具、同一参数、比完整 JSON"的判定点。
    calls = [
        # 基础形状
        ("list_transactions", {"ledger_id": "L1", "limit": 50}),
        ("list_transactions", {"ledger_id": "L1", "date_from": "2026-05-02", "date_to": "2026-05-02"}),
        ("list_transactions", {"ledger_id": "L1", "min_amount": 20, "max_amount": 100}),
        ("get_transaction", {"ledger_id": "L1", "sync_id": "t1"}),
        ("list_categories", {"ledger_id": "L1"}),
        ("list_accounts", {"ledger_id": "L1"}),
        ("list_tags", {"ledger_id": "L1"}),
        ("list_budgets", {"ledger_id": "L1"}),
        ("get_ledger_stats", {"ledger_id": "L1"}),
        ("get_analytics_summary", {"ledger_id": "L1", "scope": "month", "period": "2026-05"}),
        # 第3条：补齐 analytics 的 year / all 聚合口径（此前仅 month）
        ("get_analytics_summary", {"ledger_id": "L1", "scope": "year", "period": "2026"}),
        ("get_analytics_summary", {"ledger_id": "L1", "scope": "all"}),
        ("search", {"q": "星巴克", "limit": 20}),
        # 分页：游标编码本身也是对拍点（stableStringify 排序键必须一致）
        ("list_transactions", {"ledger_id": "L1", "limit": 2}),
        # 过滤分支
        ("list_categories", {"ledger_id": "L1", "kind": "income"}),
        ("list_accounts", {"ledger_id": "L1", "account_type": "bank"}),
        ("list_transactions", {"ledger_id": "L1", "date_from": "2026-05-11"}),
        ("list_transactions", {"ledger_id": "L1", "date_to": "2026-05-02"}),
        # 按标签 / 类型过滤（这两个参数上游确实有，早期版本矩阵里误删过）
        ("list_transactions", {"ledger_id": "L1", "tag_id": "g1"}),
        ("list_transactions", {"ledger_id": "L1", "tx_type": "income"}),
        # 非整点时区：+05:30 与 -04:00（夏令时）的日期边界折算最容易差一小时
        ("list_transactions", {"ledger_id": "L1", "date_from": "2026-05-02", "date_to": "2026-05-02",
                               "time_zone": "Asia/Kolkata"}),
        ("list_transactions", {"ledger_id": "L1", "date_from": "2026-05-02", "date_to": "2026-05-02",
                               "time_zone": "America/New_York"}),
        # 搜索：命中标签名 / 无命中 / limit 边界
        ("search", {"q": "出差", "limit": 20}),
        ("search", {"q": "不存在的关键词xyz", "limit": 20}),
        ("search", {"q": "星巴克", "limit": 1}),
        # 匹配规则：空串 / 纯空白 → 空；分类名、账户名、标签名各自参与匹配
        ("search", {"q": "", "limit": 20}),
        ("search", {"q": "   ", "limit": 20}),
        ("search", {"q": "餐饮", "limit": 20}),   # 分类名
        ("search", {"q": "现金", "limit": 20}),   # 账户名
        ("search", {"q": "招行", "limit": 20}),   # 另一账户（含转账的 from/to）
        ("search", {"q": "客户", "limit": 20}),   # 第二个标签名
        ("search", {"q": "同秒", "limit": 20}),   # 子串
        ("search", {"q": "星巴克 出差", "limit": 20}),  # 不是 AND，整串当子串
        # LIKE 通配符必须被转义：% 与 _ 是通配符，字面量应查不到
        ("search", {"q": "%", "limit": 20}),
        ("search", {"q": "_", "limit": 20}),
        ("search", {"q": "\\", "limit": 20}),
        ("search", {"q": "星巴克", "limit": 0}),    # 下限夹到 1
        ("search", {"q": "星巴克", "limit": 999}),  # 上限夹到 100
        # 不传 ledger_id：默认账本解析路径
        ("list_transactions", {"limit": 50}),
        ("list_categories", {}),
        ("list_accounts", {}),
        # 账户余额：reconcile_account 的 account 字段就来自这里（scope 语义一并覆盖）
        ("get_account_balances", {}),
        ("get_account_balances", {"ledger_id": "L1"}),
        ("get_account_balances", {"ledger_id": "L1", "scope": "visible"}),
        ("get_account_balances", {"ledger_id": "L1", "at": "2026-05-02T23:59:59Z", "scope": "visible"}),
        ("get_account_balances", {"ledger_id": "L1", "at": "2026-05-02T23:59:59Z",
                                  "scope": "visible", "time_zone": "Asia/Kolkata"}),
        ("list_tags", {}),
        ("list_budgets", {}),
        ("get_ledger_stats", {}),
        # 空账本：空数组 / 0 / null 的形状
        ("list_transactions", {"ledger_id": "L3", "limit": 50}),
        ("list_categories", {"ledger_id": "L3"}),
        ("list_accounts", {"ledger_id": "L3"}),
        ("list_tags", {"ledger_id": "L3"}),
        ("list_budgets", {"ledger_id": "L3"}),
        ("get_ledger_stats", {"ledger_id": "L3"}),
        ("get_analytics_summary", {"ledger_id": "L3", "scope": "month", "period": "2026-05"}),
        # 账本列表：u1 拥有 L1、且被共享 L2/L3（可见账本语义一并覆盖）
        ("list_ledgers", {}),
        ("get_active_ledger", {}),
        # 错误路径：两侧必须都报错（消息不比对，但"是否报错"必须一致）
        ("list_transactions", {"ledger_id": "NOPE"}),
        ("list_categories", {"ledger_id": "NOPE"}),
        ("get_ledger_stats", {"ledger_id": "NOPE"}),
        ("get_transaction", {"ledger_id": "L1", "sync_id": "nope"}),
        ("get_analytics_summary", {"ledger_id": "L1", "scope": "month", "period": "not-a-period"}),
        # 错误消息文本也是契约：非法枚举值 / 坏游标 / 越界 limit
        ("list_transactions", {"ledger_id": "L1", "tx_type": "bogus"}),
        ("list_transactions", {"ledger_id": "L1", "cursor": "not-a-cursor"}),
        ("list_transactions", {"ledger_id": "L1", "limit": 0}),
        ("list_transactions", {"ledger_id": "L1", "limit": 999}),
        ("get_analytics_summary", {"ledger_id": "L1", "scope": "week", "period": "2026-05"}),
        # 附件画廊：夹具没有挂附件的交易 → 空画廊（items/total/transaction_total 形状）
        ("list_attachments", {"ledger_id": "L1"}),
        ("list_attachments", {"ledger_id": "L1", "q": "foo"}),
        ("list_attachments", {"ledger_id": "L1", "limit": 10, "offset": 0}),
        ("list_attachments", {"ledger_id": "NOPE"}),
        # 记账上下文：显式选账本 + 默认账本解析（u1 可见 3 账本 → selection_required）
        ("get_bookkeeping_context", {"ledger_id": "L1"}),
        ("get_bookkeeping_context", {}),
        # 聚合分析（确定性读工具；显式传 time_zone 让两侧分组边界一致）
        ("analyze_transactions", {"ledger_id": "L1", "group_by": "month", "time_zone": "Asia/Shanghai"}),
        ("analyze_transactions", {"ledger_id": "L1", "group_by": "category", "time_zone": "Asia/Shanghai"}),
        ("analyze_transactions", {"ledger_id": "L1", "group_by": "type", "time_zone": "Asia/Shanghai"}),
        # 净资产的确定性历史 + 账本成员；显式 time_zone 保证两侧一致
        ("get_net_worth_history", {"ledger_id": "L1", "time_zone": "Asia/Shanghai"}),
        ("list_ledger_members", {"ledger_id": "L1"}),
    ]

    def normalize(v):
        if isinstance(v, datetime):
            return v.replace(tzinfo=v.tzinfo or timezone.utc).isoformat()
        if isinstance(v, dict):
            return {k: normalize(x) for k, x in sorted(v.items())}
        if isinstance(v, (list, tuple)):
            return [normalize(x) for x in v]
        return v

    owner = db.get(User, "u1")
    golden = {"now": NOW.isoformat(), "droppedSeedKeys": sorted(dropped_keys), "cases": []}
    for tool, args in calls:
        # 只读工具分散在 read_tools / capability_tools / file_tools 三个模块
        fn = getattr(read_tools, tool, None) or getattr(capability_tools, tool, None) \
            or getattr(file_tools, tool, None) or getattr(analysis_tools, tool, None) \
            or getattr(workflow_tools, tool, None) or getattr(rule_tools, tool, None)
        try:
            result = normalize(fn(owner, **args))
            golden["cases"].append({"tool": tool, "args": args, "result": result})
        except Exception as exc:  # 上游报错本身也是一条契约
            golden["cases"].append({"tool": tool, "args": args,
                                    "error": f"{type(exc).__name__}: {exc}"})

    # ---------------- 写路径场景：写入 → 回读 → 更新 → 删除 ----------------
    # 上游写工具通过 in-process ASGI self-call 打自己的 write router，
    # 所以这里要先把 src.main:app 拉起来（get_internal_client 会 late-bind）。
    from src.mcp.tools import write_tools  # type: ignore

    VOLATILE = {"revision", "created_at", "updated_at", "source_change_id", "last_change_id",
                "operation_id", "server_timestamp"}
    SEEDED_TAGS = {"g1", "g2"}
    _UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
    _SYNC_ID_RE = re.compile(r"^(tx|acc|cat|tag|bgt)_[0-9a-f]{12}$")

    def scrub_tag_ids(value, new_id):
        """写工具会自动补「MCP」标签（sync_id 每次不同）；其余按 <AUTO_TAG> 归一后排序。"""
        if not isinstance(value, list):
            return scrub(value, new_id)
        mapped = [v if isinstance(v, str) and v in SEEDED_TAGS else "<AUTO_TAG>" for v in value]
        return sorted(mapped)

    def scrub(value, new_id):
        """去掉一次运行就变的字段；把新建行的 sync_id 归一成 <NEW>。"""
        if isinstance(value, dict):
            out = {}
            for k, v in sorted(value.items()):
                if k in VOLATILE:
                    continue
                # created_revisions 是 {随机 sync_id: 版本号}：键随机、值才是契约，
                # 直接归一键会撞成同一个键（两条变一条），故只取值的多重集合
                if k == "created_revisions" and isinstance(v, dict):
                    out[k] = sorted(scrub(x, new_id) for x in v.values())
                    continue
                key = "<SYNC_ID>" if _SYNC_ID_RE.match(k) else k
                out[key] = scrub_tag_ids(v, new_id) if k == "tag_ids" else scrub(v, new_id)
            return out
        if isinstance(value, (list, tuple)):
            return [scrub(v, new_id) for v in value]
        if isinstance(value, str):
            if new_id and value == new_id:
                return "<NEW>"
            # 预览 id、操作批 id 等每次运行都是新 uuid
            if _UUID_RE.match(value):
                return "<UUID>"
            # 新建实体的 sync_id：{prefix}_{uuid4().hex[:12]}，随机部分每次都不同
            if _SYNC_ID_RE.match(value):
                return "<SYNC_ID>"
        return value

    scenario = {"name": "write_cycle", "steps": []}
    state = {"new_id": None}

    def extract_new_id(res):
        """从创建结果里取新建实体的 sync_id：兼容顶层 sync_id/new_id/entity_id、
        sync_ids 数组、results[].entity_id（manage 写走 operationOut，无顶层 sync_id）。
        注意：record 类的 id 是 uuid（易变），不作为 new_id；new_id 仅用于 sync_id 类实体。"""
        if not isinstance(res, dict):
            return None
        for k in ("sync_id", "new_id", "entity_id"):
            if res.get(k):
                return res[k]
        sids = res.get("sync_ids")
        if isinstance(sids, list) and sids:
            return sids[0]
        results = res.get("results")
        if isinstance(results, list):
            for r in results:
                if isinstance(r, dict) and r.get("entity_id"):
                    return r["entity_id"]
        return None

    import inspect

    def _call(fn, *args, **kwargs):
        """自适应调用：上游 1.9.0 中 capability_tools.* 多为 async，而 rule_tools.save_* 为同步；
        按是否为协程函数决定是否需要 asyncio.run，避免 'a coroutine was expected'。"""
        if inspect.iscoroutinefunction(fn):
            return asyncio.run(fn(*args, **kwargs))
        return fn(*args, **kwargs)

    def step(name, thunk):
        try:
            res = thunk()
            state["last_raw"] = res
            # 任何创建类步骤都更新 new_id（事务 create 与管理写 manage_*_create 都算）
            if name == "create" or name.endswith("_create"):
                nid = extract_new_id(res)
                if nid:
                    state["new_id"] = nid
            # 周期规则创建返回 record_out（id 是 uuid，而非 sync_id）：后续删除步骤需要该 id，
            # 且 record id 不应走普通 extract_new_id（否则分类规则/复核项会被误遮成 <NEW>）。
            if name == "manage_recurring_rule_create" and isinstance(res, dict) and res.get("id"):
                state["new_id"] = res["id"]
            scenario["steps"].append({"name": name, "result": scrub(normalize(res), state["new_id"])})
        except Exception as exc:
            scenario["steps"].append({"name": name, "error": f"{type(exc).__name__}: {exc}"})

    def plan_id_of(res):
        """预览结果里的 plan id：可能在顶层，也可能在 plan 对象里。"""
        if not isinstance(res, dict):
            return None
        for holder in (res, res.get("plan") if isinstance(res.get("plan"), dict) else {}):
            for key in ("plan_id", "id", "record_id"):
                if isinstance(holder.get(key), str):
                    return holder[key]
        return None

    step("create", lambda: asyncio.run(write_tools.create_transaction(
        owner, amount=42.5, tx_type="expense", category="餐饮", account="现金",
        happened_at="2026-05-15T10:00:00+08:00", note="差分写入", tags=["出差"], ledger_id="L1")))
    step("get_after_create", lambda: read_tools.get_transaction(owner, state["new_id"], ledger_id="L1"))
    step("update", lambda: asyncio.run(write_tools.update_transaction(
        owner, sync_id=state["new_id"], amount=99.5, note="改过的备注", ledger_id="L1")))
    step("get_after_update", lambda: read_tools.get_transaction(owner, state["new_id"], ledger_id="L1"))
    step("delete_without_confirm", lambda: asyncio.run(write_tools.delete_transaction(
        owner, sync_id=state["new_id"], ledger_id="L1")))
    step("delete", lambda: asyncio.run(write_tools.delete_transaction(
        owner, sync_id=state["new_id"], confirm=True, ledger_id="L1")))
    step("get_after_delete", lambda: read_tools.get_transaction(owner, state["new_id"], ledger_id="L1"))
    step("list_total_after", lambda: {
        "total": read_tools.list_transactions(owner, ledger_id="L1", limit=50).get("total"),
        "has_more": read_tools.list_transactions(owner, ledger_id="L1", limit=50).get("has_more"),
    })
    # 导入预览：解析 CSV → 生成草稿（不写交易）。语义全在解析与字段映射上
    from src.mcp import file_tools  # type: ignore

    step("preview_import_file", lambda: asyncio.run(file_tools.preview_import_file(
        owner, "f1", time_zone="Asia/Shanghai")))

    # 导入执行：不 confirm → confirmation_required；confirm → 真正写交易
    from src.mcp import workflow_tools  # type: ignore

    def plan_revision_of(res):
        """执行时要带预览时的 base_revision，否则上游报 REVISION_CONFLICT。"""
        if not isinstance(res, dict):
            return None
        plan = res.get("plan")
        data = plan.get("data") if isinstance(plan, dict) else None
        return data.get("base_revision") if isinstance(data, dict) else None

    plan_id = plan_id_of(state.get("last_raw"))
    plan_rev = plan_revision_of(state.get("last_raw")) or 0
    step("execute_import_plan_no_confirm", lambda: asyncio.run(workflow_tools.execute_import_plan(
        owner, plan_id, plan_rev)))

    # 错误 revision 必须被拒（这是契约：写操作要防"预览之后账本变了"）
    step("execute_import_plan_wrong_revision", lambda: asyncio.run(
        workflow_tools.execute_import_plan(owner, plan_id, 0, confirm=True)))

    # 正确 revision = plan 记录自身的 revision（上游校验的是 row.revision，
    # 与 data.base_revision 不是同一个值，预览结果里也不暴露，只能直接读表）
    from sqlalchemy import text as sa_text  # type: ignore

    plan_record_rev = db.execute(
        sa_text("SELECT revision FROM mcp_state_records WHERE id = :i"), {"i": plan_id}
    ).scalar()
    step("execute_import_plan", lambda: asyncio.run(workflow_tools.execute_import_plan(
        owner, plan_id, plan_record_rev, confirm=True)))
    # 必须在下一个 step 之前取：state["last_raw"] 每一步都会覆盖
    exec_raw = state.get("last_raw")
    step("list_total_after_import", lambda: {
        "total": read_tools.list_transactions(owner, ledger_id="L1", limit=50).get("total")})

    created_ids = (exec_raw or {}).get("sync_ids") if isinstance(exec_raw, dict) else None
    created_ids = created_ids or []
    if not created_ids and isinstance(exec_raw, dict):
        for res in exec_raw.get("results") or []:
            created_ids = (res or {}).get("created_sync_ids") or []
            if created_ids:
                break
    created_id = created_ids[0] if created_ids else None

    # ---------------- 对账：余额比对 + 检查点 ----------------
    # a1 = 现金（cash），账户是用户全局的，选哪个账本只决定归属/鉴权
    step("reconcile_account", lambda: workflow_tools.reconcile_account(
        owner, "L1", "a1", "2026-05-02T23:59:59Z", 1000.0, "UTC"))
    step("reconcile_account_tz_kolkata", lambda: workflow_tools.reconcile_account(
        owner, "L1", "a1", "2026-05-02T23:59:59Z", 1000.0, "Asia/Kolkata"))
    step("reconcile_account_nan", lambda: workflow_tools.reconcile_account(
        owner, "L1", "a1", "2026-05-02T23:59:59Z", float("nan"), "UTC"))
    step("reconcile_account_bad_account", lambda: workflow_tools.reconcile_account(
        owner, "L1", "nope", "2026-05-02T23:59:59Z", 1000.0, "UTC"))
    step("save_reconciliation_checkpoint_no_confirm",
         lambda: workflow_tools.save_reconciliation_checkpoint(
             owner, "L1", "a1", "2026-05-02T23:59:59Z", 1000.0, "bank", "2026-05-01", "UTC"))
    step("save_reconciliation_checkpoint",
         lambda: workflow_tools.save_reconciliation_checkpoint(
             owner, "L1", "a1", "2026-05-02T23:59:59Z", 1000.0, "bank", "2026-05-01", "UTC", True))
    # coverage_from 晚于 at 必须被拒
    step("save_reconciliation_checkpoint_bad_range",
         lambda: workflow_tools.save_reconciliation_checkpoint(
             owner, "L1", "a1", "2026-05-02T23:59:59Z", 1000.0, "bank", "2026-06-01", "UTC", True))
    step("list_workflow_records_checkpoint",
         lambda: workflow_tools.list_workflow_records(owner, "L1", "checkpoint"))

    # ---------------- 工作流状态：计划记录 / 来源绑定 / 撤销 ----------------
    step("list_workflow_records", lambda: workflow_tools.list_workflow_records(
        owner, "L1", "import_plan"))
    step("get_workflow_record", lambda: workflow_tools.get_workflow_record(owner, plan_id))
    # 来源绑定：导入落库后交易应带一条来源（幂等键的落点）；重复绑定同一来源必须被拒
    if created_id:
        step("list_transaction_sources", lambda: workflow_tools.list_transaction_sources(
            owner, "L1", created_id))
        src_list = state.get("last_raw")
        src = src_list[0] if isinstance(src_list, list) and src_list else None
        if src:
            # source 是 pydantic 模型，不能传 dict（上游实现直接取属性）
            from src.mcp.workflow_tools import SourceInput  # type: ignore

            step("link_transaction_source_duplicate", lambda: workflow_tools.link_transaction_source(
                owner, "L1", created_id,
                SourceInput(source_system=src.get("source_system"),
                            source_id=src.get("source_id"))))
            step("unlink_transaction_source_no_confirm", lambda: workflow_tools.unlink_transaction_source(
                owner, "L1", src.get("id")))
            step("unlink_transaction_source", lambda: workflow_tools.unlink_transaction_source(
                owner, "L1", src.get("id"), confirm=True))
            step("list_transaction_sources_after_unlink", lambda: workflow_tools.list_transaction_sources(
                owner, "L1", created_id))

    # 撤销：不 confirm → confirmation_required；confirm → 只删这次导入写入的交易
    plan_record_rev2 = db.execute(
        sa_text("SELECT revision FROM mcp_state_records WHERE id = :i"), {"i": plan_id}
    ).scalar()
    step("undo_import_plan_no_confirm", lambda: asyncio.run(workflow_tools.undo_import_plan(
        owner, plan_id, plan_record_rev2)))
    step("undo_import_plan", lambda: asyncio.run(workflow_tools.undo_import_plan(
        owner, plan_id, plan_record_rev2, confirm=True)))
    step("list_total_after_undo", lambda: {
        "total": read_tools.list_transactions(owner, ledger_id="L1", limit=50).get("total")})
    step("get_workflow_record_after_undo", lambda: workflow_tools.get_workflow_record(owner, plan_id))

    # ---------------- 管理写：账户 / 分类 / 标签 / 预算 ----------------
    # 账户字段最丰富，最易在"创建后回显"形状上偏（对照 bookkeeping_context 字典的分歧）
    step("manage_account_create", lambda: asyncio.run(capability_tools.manage_account(
        owner, "create", "L1", data=capability_tools.AccountFields(
            name="新账户", account_type="bank", currency="CNY"))))
    step("manage_account_del_noconf", lambda: asyncio.run(capability_tools.manage_account(
        owner, "delete", "L1", account_id=state["new_id"])))
    step("manage_account_del", lambda: asyncio.run(capability_tools.manage_account(
        owner, "delete", "L1", account_id=state["new_id"], confirm=True)))
    step("manage_category_create", lambda: asyncio.run(capability_tools.manage_category(
        owner, "create", "L1", data=capability_tools.CategoryFields(
            name="新分类", kind="expense"))))
    step("manage_category_del_noconf", lambda: asyncio.run(capability_tools.manage_category(
        owner, "delete", "L1", category_id=state["new_id"])))
    step("manage_category_del", lambda: asyncio.run(capability_tools.manage_category(
        owner, "delete", "L1", category_id=state["new_id"], confirm=True)))
    step("manage_tag_create", lambda: asyncio.run(capability_tools.manage_tag(
        owner, "create", "L1", data=capability_tools.TagFields(
            name="新标签", color="#123456"))))
    step("manage_tag_del_noconf", lambda: asyncio.run(capability_tools.manage_tag(
        owner, "delete", "L1", tag_id=state["new_id"])))
    step("manage_tag_del", lambda: asyncio.run(capability_tools.manage_tag(
        owner, "delete", "L1", tag_id=state["new_id"], confirm=True)))
    step("manage_budget_create", lambda: asyncio.run(capability_tools.manage_budget(
        owner, "create", "L1", data=capability_tools.BudgetFields(
            type="total", amount=100.0, period="monthly"))))
    step("manage_budget_del_noconf", lambda: asyncio.run(capability_tools.manage_budget(
        owner, "delete", "L1", budget_id=state["new_id"])))
    step("manage_budget_del", lambda: asyncio.run(capability_tools.manage_budget(
        owner, "delete", "L1", budget_id=state["new_id"], confirm=True)))

    # 账本写：创建新账本 L4 → 删除确认流（create 直接返回 ledger 对象，id 在 entity_id/ledger_id）
    step("manage_ledger_create", lambda: asyncio.run(capability_tools.manage_ledger(
        owner, "create", data=capability_tools.LedgerFields(
            ledger_name="新账本", currency="CNY", month_start_day=1), ledger_id="L4")))
    step("manage_ledger_del_noconf", lambda: asyncio.run(capability_tools.manage_ledger(
        owner, "delete", ledger_id=state["new_id"])))
    step("manage_ledger_del", lambda: asyncio.run(capability_tools.manage_ledger(
        owner, "delete", ledger_id=state["new_id"], confirm=True)))

    # ---------------- 分类规则 / 复核项 ----------------
    # 确认门控：confirmed=True 但 confirm=False → confirmation_required（无记录落库）
    step("save_classification_rule_noconf", lambda: _call(rule_tools.save_classification_rule,
        owner, "L1", data=rule_tools.ClassificationRule(
            name="咖啡分类", category_id="c1", note_contains="星巴克", confirmed=True), confirm=False))
    # 普通创建（confirmed 默认 False 直接落库）
    step("save_classification_rule_create", lambda: _call(rule_tools.save_classification_rule,
        owner, "L1", data=rule_tools.ClassificationRule(
            name="餐饮自动归类", category_id="c1", note_contains="午餐")))
    step("save_review_item_create", lambda: _call(rule_tools.save_review_item,
        owner, "L1", data=rule_tools.ReviewItem(
            question="这笔交易属于哪个分类？", transaction_ids=["t1"])))

    # 批量创建交易（对齐上游 create_transactions / 本地 createMany）
    step("create_transactions", lambda: _call(write_tools.create_transactions,
        owner,
        transactions=[
            {"tx_type": "expense", "amount": 12.5, "account_id": "a1", "category_id": "c1", "happened_at": "2026-05-13", "note": "批量咖啡"},
            {"tx_type": "income", "amount": 9000, "account_id": "a1", "category_id": "c2", "happened_at": "2026-05-20", "note": "批量工资"},
        ],
        ledger_id="L1", time_zone="Asia/Shanghai", idempotency_key="parity-batch-1"))

    # 周期规则：确认门控 + 创建 + 删除确认流（与 manage_* 同构）。
    # allow_backfill=True 使 next_occurrences 从 starts_at 起算，不依赖运行时的 datetime.now()，保证两侧确定性。
    _rr = lambda: rule_tools.RecurringRule(
        name="周期会员费",
        transaction=rule_tools.BatchTransactionItem(
            tx_type="expense", amount=10.0, account_id="a1", category_id="c1",
            happened_at="2026-05-01", note="周期扣费"),
        frequency="monthly", interval=1, starts_at="2026-05-01", time_zone="Asia/Shanghai",
        enabled=True, allow_backfill=True, dst_policy="skip")
    step("manage_recurring_rule_noconf", lambda: _call(rule_tools.manage_recurring_rule,
        owner, "create", "L1", data=_rr(), confirm=False))
    step("manage_recurring_rule_create", lambda: _call(rule_tools.manage_recurring_rule,
        owner, "create", "L1", data=_rr(), confirm=True))
    step("manage_recurring_rule_del_noconf", lambda: _call(rule_tools.manage_recurring_rule,
        owner, "delete", "L1", record_id=state["new_id"]))
    step("manage_recurring_rule_del", lambda: _call(rule_tools.manage_recurring_rule,
        owner, "delete", "L1", record_id=state["new_id"], confirm=True))

    golden["scenario"] = scenario

    # ---------------- REST 只读计算 golden（summary / budgets-usage / rates / gallery）--------
    # 这些上游实现分布在 routers/read/*，workers 在 routes/read.ts / summary.ts 里**独立重写**
    # 了同样的 SQL/计算（且带"对齐上游"注释），是最可能重演 MCP 那几类"早期错误对齐"的地方。
    # 单独产一份 golden，本地用真实路由做 HTTP 级差分（见 tests/rest-differential.test.ts）。
    # 隔离在 try 里：上游路由若因依赖缺失 import 失败，不影响主管线的 golden。
    # REST golden 用独立 DB（仅基础 seed，无写路径的 bt1/bt2 批注交易与额外附件/成员）：
    # 与本地 harness 的基础种子一致，避免写路径 undo/删除导致 golden 与本地 7 笔交易对不上。
    _orig_db = db
    db = make_db("/tmp/parity-rest.db")
    rest_golden = {"now": NOW.isoformat(), "cases": []}
    try:
        from src.routers.read.summary import get_summary  # type: ignore
        from src.routers.read.ledgers import (  # type: ignore
            list_budgets_usage, list_ledgers, get_ledger_stats, get_ledger,
            list_accounts, list_categories, list_tags, list_budgets,
        )
        from src.routers.read.rates import list_exchange_rate_overrides  # type: ignore
        from src.routers.read.attachment_gallery import list_gallery_attachments  # type: ignore

        # 这些只读响应带 exported_at / updated_at（服务端 now()），跨实例必然不同；
        # 与本地侧的 parity-compare VOLATILE 处理对齐，生成 golden 时一并剥掉。
        def scrub_read(v):
            if isinstance(v, dict):
                return {k: scrub_read(x) for k, x in v.items() if k not in ("exported_at", "updated_at")}
            if isinstance(v, list):
                return [scrub_read(x) for x in v]
            return v

        def dump_model(obj):
            if hasattr(obj, "model_dump"):
                return obj.model_dump(mode="json")
            if isinstance(obj, list):
                return [dump_model(x) for x in obj]
            return obj

        # 直接调用上游路由函数时，Query(default=None) 的默认值会变成真实的 Query 对象（truthy），
        # 触发 _to_utc 报错。故必须显式传 None / 真正的 datetime，避免走 Query 默认。
        from datetime import datetime as _dt_cls, timezone as _tz  # noqa: E402

        def _as_utc(s: str):
            return _dt_cls.fromisoformat(s).astimezone(_tz.utc)

        fn_map = {
            "get_summary": get_summary,
            "list_budgets_usage": list_budgets_usage,
            "list_exchange_rate_overrides": list_exchange_rate_overrides,
            "list_gallery_attachments": list_gallery_attachments,
            "list_ledgers": list_ledgers,
            "get_ledger": get_ledger,
            "get_ledger_stats": get_ledger_stats,
            "list_accounts": list_accounts,
            "list_categories": list_categories,
            "list_tags": list_tags,
            "list_budgets": list_budgets,
        }
        # 第3条：扩展覆盖 list_transactions 的过滤/排序/分页（上游 ledgers.py:240 独立重写路由）。
        # 单独 try 隔离，避免该上游路由 import 失败拖垮整段 REST golden。
        try:
            from src.routers.read.ledgers import list_transactions as _up_list_transactions  # type: ignore
            fn_map["list_transactions"] = _up_list_transactions
        except Exception as exc:
            print(f"[warn] list_transactions 上游路由 import 失败，跳过：{type(exc).__name__}: {exc}")

        rest_calls = [
            ("get_summary", dict(ledger_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("get_summary", dict(ledger_id="L3", _scopes=set(), current_user=owner, db=db)),
            ("list_budgets_usage", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("list_budgets_usage", dict(ledger_external_id="L3", _scopes=set(), current_user=owner, db=db)),
            ("list_exchange_rate_overrides", dict(_scopes=set(), current_user=owner, db=db)),
            # —— list_transactions 过滤/排序/分页（第3条）——
            # 注意：直接调上游路由须显式传 Query 默认值（None）或真实 datetime，否则 Query 默认对象会触发 _to_utc 报错。
            ("list_transactions", dict(ledger_external_id="L1", tx_type=None, q=None, start_at=None, end_at=None, limit=20, offset=0, _scopes=set(), current_user=owner, db=db)),
            ("list_transactions", dict(ledger_external_id="L1", tx_type="income", q=None, start_at=None, end_at=None, limit=20, offset=0, _scopes=set(), current_user=owner, db=db)),
            ("list_transactions", dict(ledger_external_id="L1", tx_type=None, q="咖啡", start_at=None, end_at=None, limit=20, offset=0, _scopes=set(), current_user=owner, db=db)),
            ("list_transactions", dict(ledger_external_id="L1", tx_type=None, q=None, start_at=_as_utc("2026-05-10T00:00:00+00:00"), end_at=_as_utc("2026-05-31T23:59:59+00:00"), limit=20, offset=0, _scopes=set(), current_user=owner, db=db)),
            ("list_transactions", dict(ledger_external_id="L1", tx_type=None, q=None, start_at=None, end_at=None, limit=3, offset=2, _scopes=set(), current_user=owner, db=db)),
            # —— 剩余 read 列表/详情/统计端点（第4条扩展）——
            ("list_ledgers", dict(_scopes=set(), current_user=owner, db=db)),
            ("get_ledger", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("get_ledger_stats", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("list_accounts", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("list_categories", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("list_tags", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("list_budgets", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
        ]
        for tool, args in rest_calls:
            fn = fn_map.get(tool)
            if fn is None:
                print(f"[warn] REST golden 跳过未导入的工具：{tool}")
                continue
            try:
                res = dump_model(fn(**args))
                rest_golden["cases"].append(
                    {"tool": tool, "args": {k: v for k, v in args.items() if k not in ("db", "_scopes", "current_user")},
                     "result": scrub_read(normalize(res))})
            except Exception as exc:
                rest_golden["cases"].append(
                    {"tool": tool, "args": {k: v for k, v in args.items() if k not in ("db", "_scopes", "current_user")},
                     "error": f"{type(exc).__name__}: {exc}"})
        rest_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-rest-golden.json")
        with open(rest_path, "w", encoding="utf-8") as rfh:
            json.dump(rest_golden, rfh, ensure_ascii=False, indent=2, default=str)
            rfh.write("\n")
        print(f"wrote {len(rest_golden['cases'])} rest cases -> {rest_path}")
        db.close()
        db = _orig_db
    except Exception as exc:
        print(f"[warn] REST golden 跳过（上游路由 import 失败）：{type(exc).__name__}: {exc}")

    # ---------------- 导入解析 golden（parse_csv_text）----------------
    # workers 在 src/services/import_data/parser.ts 里**独立重写**了 CSV/TSV 解析 +
    # 列名模糊匹配（带"对齐原版 Python"注释）。这是最可能重演"早期错误对齐"的环节：
    # 分隔符检测（上游 Sniffer 支持 ; |，workers 旧实现只认 \t 和默认 ,）、BOM 剥离、
    # 表头行探测、beecount/generic 格式识别、列名 alias 匹配。单独产一份 golden，本地
    # 直接调 workers 的 parseCsvText 做纯函数级差分（无 HTTP / 无 DB）。
    # 隔离在 try 里：上游 parser 若 import 失败，不影响主管线 golden。
    import_golden = {"cases": []}
    try:
        from src.services.import_data.parser import parse_csv_text  # type: ignore

        def _norm_mapping(m):
            return {
                "txType": m.tx_type,
                "amount": m.amount,
                "happenedAt": m.happened_at,
                "categoryName": m.category_name,
                "subcategoryName": m.subcategory_name,
                "accountName": m.account_name,
                "fromAccountName": m.from_account_name,
                "toAccountName": m.to_account_name,
                "note": m.note,
                "currency": m.currency,
                "tags": m.tags,
                "datetimeFormat": m.datetime_format,
                "stripCurrencySymbols": m.strip_currency_symbols,
                "expenseIsNegative": m.expense_is_negative,
                "tzOffsetMinutes": m.tz_offset_minutes,
            }

        def _norm_data(d):
            return {
                "sourceFormat": d.source_format,
                "headers": d.headers,
                "rows": [{"rowNumber": r.row_number, "cells": r.cells} for r in d.rows],
                "suggestedMapping": _norm_mapping(d.suggested_mapping),
            }

        import_cases = [
            # 基础 CSV + BOM（utf-8-sig）：剥离 BOM + 中文列名模糊匹配
            ("basic_bom", "﻿" + "日期,金额,类型,分类,备注\n2026-05-16,12.5,支出,餐饮,午饭\n2026-05-17,3000,收入,工资,五月工资\n"),
            # 分号分隔：上游 Sniffer 识别，workers 旧实现只认 \t 和默认 ,
            ("semicolon", "日期;金额;类型;分类\n2026-05-16;12.5;支出;餐饮\n"),
            # 制表符分隔
            ("tsv", "日期\t金额\t类型\n2026-05-16\t12.5\t支出\n"),
            # 英文列名模糊匹配
            ("english_headers", "date,amount,type,category,note\n2026-05-16,12.5,expense,food,lunch\n"),
            # 管道符分隔（同属上游 Sniffer 的 delimiter 集合）
            ("pipe", "日期|金额|类型|分类\n2026-05-16|12.5|支出|餐饮\n"),
            # beecount 自家导出格式（完整 12 列表头，score>=8 才识别为 beecount）
            ("beecount", "类型,二级分类,分类,金额,币种,账户,转出账户,转入账户,备注,时间,标签,附件\n"
                         "支出,,餐饮,12.5,CNY,现金,,,午饭,2026-05-16,餐饮tag,\n"),
            # 空输入
            ("empty", ""),
        ]
        for name, text in import_cases:
            try:
                import_golden["cases"].append(
                    {"name": name, "text": text, "result": _norm_data(parse_csv_text(raw_text=text))})
            except Exception as exc:
                import_golden["cases"].append(
                    {"name": name, "text": text, "error": f"{type(exc).__name__}: {exc}"})
        import_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-import-golden.json")
        with open(import_path, "w", encoding="utf-8") as ifh:
            json.dump(import_golden, ifh, ensure_ascii=False, indent=2, default=str)
            ifh.write("\n")
        print(f"wrote {len(import_golden['cases'])} import cases -> {import_path}")
    except Exception as exc:
        print(f"[warn] import golden 跳过（上游 parser import 失败）：{type(exc).__name__}: {exc}")

    # ---------------- 导入转换 golden（apply_mapping / transformers）----------------
    # workers 在 transformer.ts 里**独立重写**了逐行 transform（金额符号、txType 推断、
    # 日期解析、required_complete、tags 拆分），注释"对齐原版 Python transformer.py"。
    # 这里直接调上游 apply_mapping 生成 golden，本地调 workers 的 applyMapping 逐字段比。
    # 隔离在 try 里：上游 transformer import 失败则跳过。
    transform_golden = {"cases": []}
    try:
        from src.services.import_data.transformer import apply_mapping  # type: ignore
        from src.services.import_data.schema import ImportFieldMapping, ParsedRow  # type: ignore

        def _norm_dt(v):
            if not v:
                return None
            s = str(v).replace(" ", "T")
            try:
                dt = datetime.fromisoformat(s)
                if dt.tzinfo is not None:
                    dt = dt.astimezone(timezone.utc)
                # 归一到 JS 可解析的 UTC 秒级字符串（T + +00:00），避免 naive / 时区表征差异
                return dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")
            except Exception:
                return s.replace("+00:00", "").rstrip("Z")

        def _norm_tx(tx):
            return {
                "txType": tx.tx_type,
                "amount": float(tx.amount) if tx.amount is not None else None,
                "happenedAt": _norm_dt(tx.happened_at),
                "currencyCode": tx.currency_code,
                "note": tx.note,
                "categoryName": tx.category_name,
                "parentCategoryName": tx.parent_category_name,
                "accountName": tx.account_name,
                "fromAccountName": tx.from_account_name,
                "toAccountName": tx.to_account_name,
                "tagNames": tx.tag_names,
                "sourceRowNumber": tx.source_row_number,
            }

        def _norm_mapping(m):
            def g(a):
                return getattr(m, a, None)
            return {
                "txType": g("tx_type"), "amount": g("amount"), "happenedAt": g("happened_at"),
                "categoryName": g("category_name"), "subcategoryName": g("subcategory_name"),
                "accountName": g("account_name"), "fromAccountName": g("from_account_name"),
                "toAccountName": g("to_account_name"), "note": g("note"), "currency": g("currency"),
                "tags": g("tags") or [], "datetimeFormat": g("datetime_format"),
                "stripCurrencySymbols": g("strip_currency_symbols"), "expenseIsNegative": g("expense_is_negative"),
                "tzOffsetMinutes": g("tz_offset_minutes"), "requiredComplete": g("required_complete"),
            }

        def _mk_rows(cells_list):
            return [ParsedRow(row_number=i + 1, cells=cells, raw_line="") for i, cells in enumerate(cells_list)]

        def _full_map(**over):
            base = dict(tx_type="类型", amount="金额", happened_at="时间", category_name="分类",
                        account_name="账户", note="备注", tags=["标签"],
                        expense_is_negative=False,
                        strip_currency_symbols=False, datetime_format=None, tz_offset_minutes=None)
            base.update(over)
            return ImportFieldMapping(**base)

        transform_cases = [
            # 必填字段全空 → required_complete 自动为 False，上游报 PARSE_MAPPING_INCOMPLETE，本地返回空
            ("incomplete",
             ImportFieldMapping(),
             _mk_rows([{"类型": "支出", "金额": "12.5", "时间": "2026-05-16", "分类": "餐饮", "账户": "现金"}])),
            # 正常支出（tx_type/amount/happened_at 都设 → required_complete 自动 True）
            ("expense_normal",
             _full_map(),
             _mk_rows([{"类型": "支出", "金额": "12.5", "时间": "2026-05-16", "分类": "餐饮", "账户": "现金", "备注": "午饭", "标签": "出差"}])),
            # 收入列但金额为负 → 视为支出取绝对值（上游逻辑）
            ("income_negative_amount",
             _full_map(),
             _mk_rows([{"类型": "收入", "金额": "-30", "时间": "2026-05-17", "分类": "工资", "账户": "招行"}])),
            # 金额带币种符号剥离（strip_currency_symbols=True）
            ("strip_currency",
             _full_map(strip_currency_symbols=True),
             _mk_rows([{"类型": "支出", "金额": "¥1,234.5", "时间": "2026-05-18", "分类": "餐饮", "账户": "现金"}])),
            # 多币种：币种列合法 ISO 码 → 采纳为 currency_code（CNY）
            ("expense_with_currency",
             _full_map(currency="币种"),
             _mk_rows([{"类型": "支出", "金额": "12.5", "时间": "2026-05-19", "分类": "餐饮", "账户": "现金", "币种": "CNY"}])),
            # 小写合法码 → 上游大写采纳为 CNY（验证大小写归一）
            ("currency_lowercase",
             _full_map(currency="币种"),
             _mk_rows([{"类型": "支出", "金额": "12.5", "时间": "2026-05-20", "分类": "餐饮", "账户": "现金", "币种": "cny"}])),
            # 非 ISO 值（中文）→ 上游丢弃为 None；workers 旧实现会错误保留（逼出 ISO 校验修复）
            ("currency_invalid_cjk",
             _full_map(currency="币种"),
             _mk_rows([{"类型": "支出", "金额": "12.5", "时间": "2026-05-21", "分类": "餐饮", "账户": "现金", "币种": "人民币"}])),
        ]
        for name, mapping, rows in transform_cases:
            try:
                txs, errors, warnings = apply_mapping(rows=rows, mapping=mapping)
                transform_golden["cases"].append({
                    "name": name,
                    "mapping": _norm_mapping(mapping),
                    "rows": [r.cells for r in rows],
                    "result": {"txs": [_norm_tx(t) for t in txs], "errorCount": len(errors)},
                })
            except Exception as exc:
                transform_golden["cases"].append({
                    "name": name, "mapping": _norm_mapping(mapping), "rows": [r.cells for r in rows],
                    "error": f"{type(exc).__name__}: {exc}"})
        transform_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-transform-golden.json")
        with open(transform_path, "w", encoding="utf-8") as tfh:
            json.dump(transform_golden, tfh, ensure_ascii=False, indent=2, default=str)
            tfh.write("\n")
        print(f"wrote {len(transform_golden['cases'])} transform cases -> {transform_path}")
    except Exception as exc:
        print(f"[warn] transform golden 跳过：{type(exc).__name__}: {exc}")

    # ---------------- 写请求契约 golden（pydantic 模型 introspection）----------------
    # workers 用 camelCase + zod，上游用 snake_case + pydantic，两套 REST 线格式故意不同，
    # 且写入逻辑已被 MCP 差分覆盖（workers 写路由与 MCP 共用 transaction-service）。
    # 这里只比对「契约」：每个写请求模型的字段名 / 是否必填 / 类型，捕捉 zod 与 pydantic
    # 的必填性 / 类型分歧（如某字段一侧必填另一侧可选）。隔离在 try 里。
    schema_golden = {"models": {}}
    try:
        import typing
        from src.schemas import (  # type: ignore
            WriteTransactionCreateRequest, WriteCategoryCreateRequest,
            WriteAccountCreateRequest, WriteTagCreateRequest, WriteBudgetCreateRequest,
            TwoFAConfirmRequest, TwoFAVerifyRequest, TwoFADisableRequest, TwoFARegenerateRequest,
        )

        def _logical_type(ann):
            origin = typing.get_origin(ann)
            if origin is typing.Literal:
                return "enum"
            if origin is list:
                return "array"
            args = typing.get_args(ann)
            if args:
                real = [a for a in args if a is not type(None)]
                if len(real) == 1:
                    return _logical_type(real[0])
                return "array" if any(str(a).startswith(("list", "List")) for a in real) else "union"
            if ann is float or ann is int:
                return "number"
            if ann is str:
                return "str"
            if ann is bool:
                return "bool"
            s = str(ann)
            if "datetime" in s:
                return "datetime"
            if "list" in s or "List" in s:
                return "array"
            if "dict" in s or "Dict" in s:
                return "object"
            if "Literal" in s:
                return "enum"
            return s.split("'")[1] if "'" in s else s

        def _describe(model):
            out = {}
            for name, field in model.model_fields.items():
                out[name] = {
                    "required": bool(field.is_required()),
                    "type": _logical_type(field.annotation),
                }
            return out

        for label, model in [
            ("transactionCreate", WriteTransactionCreateRequest),
            ("categoryCreate", WriteCategoryCreateRequest),
            ("accountCreate", WriteAccountCreateRequest),
            ("tagCreate", WriteTagCreateRequest),
            ("budgetCreate", WriteBudgetCreateRequest),
            ("twoFAConfirm", TwoFAConfirmRequest),
            ("twoFAVerify", TwoFAVerifyRequest),
            ("twoFADisable", TwoFADisableRequest),
            ("twoFARegenerate", TwoFARegenerateRequest),
        ]:
            schema_golden["models"][label] = _describe(model)
        schema_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-write-schema-golden.json")
        with open(schema_path, "w", encoding="utf-8") as sfh:
            json.dump(schema_golden, sfh, ensure_ascii=False, indent=2, default=str)
            sfh.write("\n")
        print(f"wrote {len(schema_golden['models'])} write schema models -> {schema_path}")
    except Exception as exc:
        print(f"[warn] write schema golden 跳过：{type(exc).__name__}: {exc}")

    # ---------------- admin/ai 请求契约 golden ----------------
    # admin + ai 子系统的写请求模型 introspection（zod vs pydantic 必填性/类型）。
    # 与写契约同理：这些子系统 workers 已实现，字段须对齐。隔离在 try 里，且 admin
    # 与 ai 分两个 try（ai 路由 import 可能较重），互不影响。
    subsystems_golden: dict = {"models": {}}

    def _sub_logical_type(ann):
        # 拆包 PEP 695 type 别名（如上游 TestProviderProvider = str | ProviderConfig），
        # 否则 pydantic 存的是别名对象，get_origin/get_args 取不到 Union。
        if hasattr(ann, "__value__"):
            ann = ann.__value__
        origin = typing.get_origin(ann)
        if origin is typing.Literal:
            return "enum"
        if origin is list:
            return "array"
        if origin is typing.Union or origin is getattr(types, "UnionType", None):
            return "union"
        args = typing.get_args(ann)
        if args:
            real = [a for a in args if a is not type(None)]
            if len(real) == 1:
                return _sub_logical_type(real[0])
            return "union"
        if ann is float or ann is int:
            return "number"
        if ann is str:
            return "str"
        if ann is bool:
            return "bool"
        s = str(ann)
        if "datetime" in s:
            return "datetime"
        if "list" in s or "List" in s:
            return "array"
        if "dict" in s or "Dict" in s:
            return "object"
        if "Literal" in s:
            return "enum"
        # 兜底：任何无法归类的类型（类对象 / PEP695 type 别名等）一律按 union 处理，
        # 与 workers 的 union 宽泛兼容，避免因别名未被拆包而误报类型分歧。
        return "union"

    def _sub_describe(model):
        out = {}
        for name, field in model.model_fields.items():
            out[name] = {
                "required": bool(field.is_required()),
                "type": _sub_logical_type(field.annotation),
            }
        return out

    try:
        from src.schemas import (  # type: ignore
            UserAdminCreateRequest, UserAdminPatchRequest, UserAdminPasswordChangeRequest,
            AdminBackupCreateRequest, AdminBackupRestoreRequest,
        )
        for label, model in [
            ("adminUserCreate", UserAdminCreateRequest),
            ("adminUserPatch", UserAdminPatchRequest),
            ("adminPasswordChange", UserAdminPasswordChangeRequest),
            ("adminBackupCreate", AdminBackupCreateRequest),
            ("adminBackupRestore", AdminBackupRestoreRequest),
        ]:
            subsystems_golden["models"][label] = _sub_describe(model)
        print(f"describe admin models ok -> {len(subsystems_golden['models'])}")
    except Exception as exc:
        print(f"[warn] admin schema golden 跳过：{type(exc).__name__}: {exc}")

    try:
        from src.routers.ai.parse_tx_text import ParseTxTextRequest  # type: ignore
        from src.routers.ai.ask import AskRequest  # type: ignore
        from src.routers.ai.test_provider import TestProviderRequest  # type: ignore
        for label, model in [
            ("aiParseTxText", ParseTxTextRequest),
            ("aiAsk", AskRequest),
            ("aiTestProvider", TestProviderRequest),
        ]:
            subsystems_golden["models"][label] = _sub_describe(model)
        print(f"describe ai models ok -> {len(subsystems_golden['models'])}")
    except Exception as exc:
        print(f"[warn] ai schema golden 跳过：{type(exc).__name__}: {exc}")

    try:
        sub_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-subsystems-schema-golden.json")
        with open(sub_path, "w", encoding="utf-8") as sfh:
            json.dump(subsystems_golden, sfh, ensure_ascii=False, indent=2, default=str)
            sfh.write("\n")
        print(f"wrote {len(subsystems_golden['models'])} subsystems schema models -> {sub_path}")
    except Exception as exc:
        print(f"[warn] subsystems schema golden 写入跳过：{type(exc).__name__}: {exc}")

    # ---------------- sync/pull 响应 golden ----------------
    # 客户端增量同步协议：两侧响应结构已核对一致（changes[change_id,ledger_id,entity_type,
    # entity_sync_id,action,payload,updated_at,updated_by_device_id,scope] + server_cursor
    # + has_more）。用「两侧插同一条 change」的方式验证 pull 响应（信封 + change 结构 +
    # payload 原样透传）。直接调 pull_changes（绕过 scope 依赖，与 read golden 同构）。
    try:
        from sqlalchemy import delete as _sa_delete
        from src.models import SyncChange  # type: ignore
        from src.routers.sync.pull import pull_changes  # type: ignore

        # 前面的 golden 步骤可能会顺带写 sync_changes（占用 change_id），先清空，
        # 再插入本块要对比的 2 条。不显式指定 change_id（交给自增），因为归一化时
        # 会丢弃 change_id / server_cursor（游标类易变字段），只比其余结构 + payload。
        db.execute(_sa_delete(SyncChange))
        db.flush()
        fake_user = db.get(User, "u1")
        upd = datetime(2026, 5, 16, 3, 30, 0, tzinfo=timezone.utc)
        for etype, esid, payload in [
            ("transaction", "t-sync-1", {
                "sync_id": "t-sync-1", "tx_type": "expense", "amount": 12.5,
                "happened_at": "2026-05-16T03:30:00Z", "note": "午饭",
                "category_sync_id": "c1", "account_sync_id": "a1", "currency_code": "CNY",
                "tags": [], "createdByUserId": "u1", "updatedByUserId": "u1",
            }),
            ("category", "c-sync-1", {
                "sync_id": "c-sync-1", "name": "餐饮", "kind": "expense",
                "sort_order": 1, "icon": "🍜",
            }),
        ]:
            db.add(SyncChange(user_id="u1", ledger_id="L1-i", scope="ledger",
                entity_type=etype, entity_sync_id=esid, action="upsert",
                payload_json=payload, updated_at=upd,
                updated_by_device_id=None, updated_by_user_id="u1"))
        db.commit()
        resp = pull_changes(since=0, device_id=None, limit=1000, _scopes=set(),
                            current_user=fake_user, db=db)
        sync_golden = resp.model_dump(mode="json")
        sync_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-sync-golden.json")
        with open(sync_path, "w", encoding="utf-8") as sfh:
            json.dump(sync_golden, sfh, ensure_ascii=False, indent=2, default=str)
            sfh.write("\n")
        print(f"wrote sync pull golden -> {sync_path}")
    except Exception as exc:
        print(f"[warn] sync pull golden 跳过：{type(exc).__name__}: {exc}")

    # ---------------- device LIST + REVOKE 响应 golden ----------------
    # 设备 LIST（GET /devices）响应结构（DeviceOut 字段集）契约差分。设备登录时自动
    # 创建、无请求体，所以这里比「响应」而非「请求」。直接调 list_devices。
    # REVOKE（POST /devices/{device_id}/revoke）端点响应也纳入：上游对「已撤销设备重复
    # revoke」幂等返回 200，本地已对齐（devices.ts 不再过滤 revoked_at IS NULL）。
    try:
        from src.models import Device  # type: ignore
        from src.routers.devices import list_devices, revoke_device  # type: ignore

        # 用固定近期时间戳（不要 5 个月前的旧时间，否则 active_within_days 窗口会把它过滤掉，
        # 两侧都返回空列表）。超大窗口确保设备始终被包含，且值固定可跨时间稳定比对。
        upd = datetime(2026, 10, 30, 3, 30, 0, tzinfo=timezone.utc)

        # revoke_device 内部用 current_user.id 过滤设备；list_devices 也接收 current_user。
        # 直接给一个带 id="u1" 的轻量假用户（无需在 DB 真建 User 行）。
        class _FakeUser:
            id = "u1"
        fake_user = _FakeUser()
        db.add(Device(id="dev-1", user_id="u1", name="iPhone", platform="ios",
                      app_version="1.0.0", os_version="17.0", device_model="iPhone15,2",
                      last_ip="1.2.3.4", last_seen_at=upd, created_at=upd))
        db.commit()
        # 先抓 LIST（dev-1 仍 active），再 revoke（状态变更），避免 revoke 影响 LIST 快照。
        devs = list_devices(view="sessions", active_within_days=73000, _scopes=set(),
                            current_user=fake_user, db=db)
        device_list = [d.model_dump(mode="json") for d in devs]
        rev = revoke_device(device_id="dev-1", current_user=fake_user, db=db)
        device_golden = {
            "list": device_list,
            "revoke": {"status": 200, "result": rev},
        }
        dev_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-device-golden.json")
        with open(dev_path, "w", encoding="utf-8") as sfh:
            json.dump(device_golden, sfh, ensure_ascii=False, indent=2, default=str)
            sfh.write("\n")
        print(f"wrote device golden -> {dev_path}")
    except Exception as exc:
        print(f"[warn] device golden 跳过：{type(exc).__name__}: {exc}")

    # ---------------- 鉴权 golden（HTTP /api/v1/auth/*）----------------
    # 用上游 FastAPI app 的 TestClient 直接打路由，与本地 Hono auth 路由逐场景对拍。
    # 排除随机字段：access_token/refresh_token/challenge_token/device_id/user.id。
    try:
        os.environ.setdefault("JWT_SECRET", "test-secret-for-parity-0123456789")
        os.environ["REGISTRATION_ENABLED"] = "true"
        os.environ["APP_ENV"] = "development"
        try:
            from src.config import get_settings  # type: ignore
            get_settings.cache_clear()
        except Exception:
            pass
        from fastapi.testclient import TestClient  # type: ignore
        from src.main import app as _auth_app  # type: ignore
        _auth_client = TestClient(_auth_app)
        AUTH_VOLATILE = {"access_token", "refresh_token", "challenge_token", "device_id"}

        def _scrub_auth(v):
            if isinstance(v, list):
                return [_scrub_auth(x) for x in v]
            if isinstance(v, dict):
                out = {}
                for k, x in v.items():
                    if k in AUTH_VOLATILE:
                        continue
                    if k == "user" and isinstance(x, dict):
                        out[k] = {kk: xx for kk, xx in x.items() if kk != "id"}
                        continue
                    out[k] = _scrub_auth(x)
                return out
            return v

        _auth_steps = []
        def _do(name, method, path, json_body=None, headers=None):
            fn = getattr(_auth_client, method)
            kw = {}
            if json_body is not None:
                kw["json"] = json_body
            if headers:
                kw["headers"] = headers
            resp = fn(path, **kw)
            body = resp.json() if resp.status_code != 204 and resp.content else None
            _auth_steps.append({
                "name": name,
                "request": {"method": method.upper(), "path": path, "json": json_body},
                "status": resp.status_code,
                "result": _scrub_auth(body) if body is not None else None,
            })
            return resp, body

        _do("register", "post", "/api/v1/auth/register", {
            "email": "authtest@example.com", "password": "password123",
            "client_type": "web", "device_name": "CI"})
        _do("register_dup", "post", "/api/v1/auth/register", {
            "email": "authtest@example.com", "password": "password123",
            "client_type": "web", "device_name": "CI"})
        _do("register_weak", "post", "/api/v1/auth/register", {
            "email": "weak@example.com", "password": "short", "client_type": "web"})
        _do("register_bademail", "post", "/api/v1/auth/register", {
            "email": "notanemail", "password": "password123", "client_type": "web"})
        _login_resp, _login_body = _do("login", "post", "/api/v1/auth/login", {
            "email": "authtest@example.com", "password": "password123", "client_type": "web"})
        _refresh_token = (_login_body or {}).get("refresh_token")
        _access_token = (_login_body or {}).get("access_token")
        _do("login_wrong", "post", "/api/v1/auth/login", {
            "email": "authtest@example.com", "password": "wrongpass", "client_type": "web"})
        if _refresh_token:
            _do("refresh", "post", "/api/v1/auth/refresh", {"refresh_token": _refresh_token})
        # 注：/me 属于 profile router（/api/v1/profile/me），不在 auth router，
        # 故不纳入 auth golden；profile 模块的 parity 单独覆盖。
        if _refresh_token:
            _do("logout", "post", "/api/v1/auth/logout", {"refresh_token": _refresh_token})

        _auth_golden = {"steps": _auth_steps}
        _auth_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-auth-golden.json")
        with open(_auth_path, "w", encoding="utf-8") as _afh:
            json.dump(_auth_golden, _afh, ensure_ascii=False, indent=2, default=str)
            _afh.write("\n")
        print(f"wrote {len(_auth_steps)} auth steps -> {_auth_path}")
    except Exception as exc:
        import traceback
        print(f"[warn] auth golden 跳过：{type(exc).__name__}: {exc}")
        traceback.print_exc()

    # ---------------- profile golden（HTTP /api/v1/profile/*）----------------
    # 注册+登录拿 token，打 /api/v1/profile/me（GET/PUT）。scrub user_id/avatar_url
    # （avatar_url 含 host，user_id 为随机 uuid）。其余确定性字段（email/display_name/
    # income_is_red/theme_primary_color/primary_currency 等）逐字段比对。
    try:
        from fastapi.testclient import TestClient  # type: ignore
        from src.main import app as _profile_app  # type: ignore
        _pclient = TestClient(_profile_app)
        _pclient.post("/api/v1/auth/register", json={"email": "authtest@example.com", "password": "password123", "client_type": "web", "device_name": "CI"})
        _plr = _pclient.post("/api/v1/auth/login", json={"email": "authtest@example.com", "password": "password123", "client_type": "web"})
        _pat = (_plr.json() or {}).get("access_token")
        _phdr = {"Authorization": f"Bearer {_pat}"}

        def _scrub_profile(v):
            if isinstance(v, dict):
                return {k: _scrub_profile(x) for k, x in v.items() if k not in ("user_id", "avatar_url")}
            if isinstance(v, list):
                return [_scrub_profile(i) for i in v]
            return v

        _prof_steps = []
        def _pstep(name, method, path, json_body=None, headers=None):
            fn = getattr(_pclient, method)
            kw = {}
            if json_body is not None:
                kw["json"] = json_body
            if headers:
                kw["headers"] = headers
            resp = fn(path, **kw)
            body = resp.json() if resp.status_code != 204 and resp.content else None
            _prof_steps.append({"name": name, "request": {"method": method.upper(), "path": path, "json": json_body}, "status": resp.status_code, "result": _scrub_profile(body) if body is not None else None})

        _pstep("get_me", "get", "/api/v1/profile/me", headers=_phdr)
        _pstep("patch_me", "patch", "/api/v1/profile/me", json_body={"display_name": "新昵称", "income_is_red": True, "theme_primary_color": "#123456"}, headers=_phdr)
        # 注：上游 profile 路由只有 PATCH /me 与 POST /avatar，无 change-password 端点
        # （本地 change-password 为额外功能，无上游可比，故不纳入 golden）。
        # avatar 上传依赖 R2 对象存储（架构差异），亦不纳入。

        _pg = {"steps": _prof_steps}
        _pp = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-profile-golden.json")
        with open(_pp, "w", encoding="utf-8") as _pfh:
            json.dump(_pg, _pfh, ensure_ascii=False, indent=2, default=str)
            _pfh.write("\n")
        print(f"wrote {len(_prof_steps)} profile steps -> {_pp}")
    except Exception as exc:
        import traceback
        print(f"[warn] profile golden 跳过：{type(exc).__name__}: {exc}")
        traceback.print_exc()

    # ---------------- two_factor golden（HTTP /api/v1/two_factor/*）----------------
    # 2FA 的 TOTP secret 由服务端随机生成，golden 与本地 replay 的 secret 不同，
    # 无法简单重放 code。故 golden 只记录各步骤的状态码+响应结构（scrub 掉
    # secret/qr_code_uri/recovery_codes/enabled_at），本地测试自建完整流程逐步骤比对结构。
    try:
        from fastapi.testclient import TestClient  # type: ignore
        from src.main import app as _2fa_app  # type: ignore
        _2fa_client = TestClient(_2fa_app)
        _2fa_client.post("/api/v1/auth/register", json={"email": "2fa@example.com", "password": "password123", "client_type": "web", "device_name": "CI"})
        _2fa_lr = _2fa_client.post("/api/v1/auth/login", json={"email": "2fa@example.com", "password": "password123", "client_type": "web"})
        _2fa_at = (_2fa_lr.json() or {}).get("access_token")
        _2fa_hdr = {"Authorization": f"Bearer {_2fa_at}"}

        def _totp_code(secret_b32, digits=6, period=30):
            import base64 as _b64, hashlib as _hl, hmac as _hm, struct as _st, time as _t
            s = secret_b32.upper().replace(" ", "")
            s += "=" * ((8 - len(s) % 8) % 8)
            key = _b64.b32decode(s)
            counter = int(_t.time()) // period
            msg = _st.pack(">Q", counter)
            h = _hm.new(key, msg, _hl.sha1).digest()
            o = h[-1] & 0x0f
            code = (_st.unpack(">I", h[o:o + 4])[0] & 0x7fffffff) % (10 ** digits)
            return str(code).zfill(digits)

        def _scrub_2fa(v):
            if isinstance(v, list):
                return [_scrub_2fa(i) for i in v]
            if isinstance(v, dict):
                return {k: _scrub_2fa(x) for k, x in v.items() if k not in ("secret", "qr_code_uri", "recovery_codes", "enabled_at")}
            return v

        def _add(name, method, path, resp, json_body=None):
            body = resp.json() if resp.status_code != 204 and resp.content else None
            _2fa_steps.append({"name": name, "request": {"method": method, "path": path, "json": json_body}, "status": resp.status_code, "result": _scrub_2fa(body) if body is not None else None})

        _2fa_steps = []
        r_status0 = _2fa_client.get("/api/v1/auth/2fa/status", headers=_2fa_hdr)
        _add("status_before", "GET", "/api/v1/auth/2fa/status", r_status0)
        r_setup = _2fa_client.post("/api/v1/auth/2fa/setup", headers=_2fa_hdr)
        _add("setup", "POST", "/api/v1/auth/2fa/setup", r_setup)
        _code = _totp_code(r_setup.json()["secret"])
        r_confirm = _2fa_client.post("/api/v1/auth/2fa/confirm", json={"code": _code}, headers=_2fa_hdr)
        _add("confirm", "POST", "/api/v1/auth/2fa/confirm", r_confirm, json_body={"code": "<computed>"})
        r_status1 = _2fa_client.get("/api/v1/auth/2fa/status", headers=_2fa_hdr)
        _add("status_enabled", "GET", "/api/v1/auth/2fa/status", r_status1)
        r_disable = _2fa_client.post("/api/v1/auth/2fa/disable", json={"password": "password123", "code": _totp_code(r_setup.json()["secret"])}, headers=_2fa_hdr)
        _add("disable", "POST", "/api/v1/auth/2fa/disable", r_disable, json_body={"password": "password123", "code": "<computed>"})
        r_status2 = _2fa_client.get("/api/v1/auth/2fa/status", headers=_2fa_hdr)
        _add("status_after", "GET", "/api/v1/auth/2fa/status", r_status2)

        _2fa_golden = {"steps": _2fa_steps}
        _2fa_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-two-factor-golden.json")
        with open(_2fa_path, "w", encoding="utf-8") as _f:
            json.dump(_2fa_golden, _f, ensure_ascii=False, indent=2, default=str)
            _f.write("\n")
        print(f"wrote {len(_2fa_steps)} two_factor steps -> {_2fa_path}")
    except Exception as exc:
        import traceback
        print(f"[warn] two_factor golden 跳过：{type(exc).__name__}: {exc}")
        traceback.print_exc()

    # ---------------- pats golden（HTTP /api/v1/profile/pats）----------------
    # PAT 生命周期：create(201) -> list -> patch(update) -> delete(204)。
    # token/id/prefix/created_at/expires_at 等随机或时间相关字段在 golden 中 scrub，
    # 本地测试自建相同流程逐步骤比对结构（详见 tests/pats-differential.test.ts）。
    try:
        from fastapi.testclient import TestClient  # type: ignore
        from src.main import app as _pats_app  # type: ignore
        _pc = TestClient(_pats_app)
        _pc.post("/api/v1/auth/register", json={"email": "patstest@example.com", "password": "password123", "client_type": "web", "device_name": "CI"})
        _plr = _pc.post("/api/v1/auth/login", json={"email": "patstest@example.com", "password": "password123", "client_type": "web"})
        _pat = (_plr.json() or {}).get("access_token")
        _ph = {"Authorization": f"Bearer {_pat}"}

        def _scrub_pat(v):
            if isinstance(v, list):
                return [_scrub_pat(i) for i in v]
            if isinstance(v, dict):
                return {k: _scrub_pat(x) for k, x in v.items() if k not in ("token", "id", "prefix", "created_at", "expires_at", "last_used_at", "revoked_at", "last_used_ip")}
            return v

        _pat_steps = []
        def _pstep(name, method, path, json_body=None, headers=None):
            fn = getattr(_pc, method)
            kw = {}
            if json_body is not None:
                kw["json"] = json_body
            if headers:
                kw["headers"] = headers
            resp = fn(path, **kw)
            body = resp.json() if resp.status_code != 204 and resp.content else None
            _pat_steps.append({"name": name, "request": {"method": method.upper(), "path": path, "json": json_body}, "status": resp.status_code, "result": _scrub_pat(body) if body is not None else None})

        _create_resp = _pc.post("/api/v1/profile/pats", json={"name": "ci-pat", "scopes": ["mcp:read"], "expires_in_days": None}, headers=_ph)
        _create_id = (_create_resp.json() or {}).get("id")
        _create_body = _create_resp.json() if _create_resp.content else None
        _pat_steps.append({"name": "create", "request": {"method": "POST", "path": "/api/v1/profile/pats", "json": {"name": "ci-pat", "scopes": ["mcp:read"], "expires_in_days": None}}, "status": _create_resp.status_code, "result": _scrub_pat(_create_body)})
        _pstep("list", "get", "/api/v1/profile/pats", headers=_ph)
        _pstep("update", "patch", f"/api/v1/profile/pats/{_create_id}", json_body={"name": "ci-pat-renamed"}, headers=_ph)
        _pstep("delete", "delete", f"/api/v1/profile/pats/{_create_id}", headers=_ph)

        _pg = {"steps": _pat_steps}
        _pp = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-pats-golden.json")
        with open(_pp, "w", encoding="utf-8") as _f:
            json.dump(_pg, _f, ensure_ascii=False, indent=2, default=str)
            _f.write("\n")
        print(f"wrote {len(_pat_steps)} pats steps -> {_pp}")
    except Exception as exc:
        import traceback
        print(f"[warn] pats golden 跳过：{type(exc).__name__}: {exc}")
        traceback.print_exc()

    # ---------------- attachments golden（HTTP /api/v1/attachments/*）----------------
    # 上传依赖磁盘存储（ATTACHMENT_STORAGE_DIR，main() 已设为 /tmp/parity-attach）。
    # batch-exists 仅读 DB。scrub：file_id / created_at（两侧皆随机/时间相关）。
    # 注：上游无 /exists（本地独有），故对拍只用 /upload + /batch-exists。
    try:
        from fastapi.testclient import TestClient  # type: ignore
        from src.main import app as _att_app  # type: ignore
        from src.database import SessionLocal  # type: ignore
        from src.models import Ledger, LedgerMember, User  # type: ignore
        from sqlalchemy import select  # type: ignore
        import hashlib as _hl
        _att_client = TestClient(_att_app)
        _att_client.post("/api/v1/auth/register", json={"email": "atttest@example.com", "password": "password123", "client_type": "web", "device_name": "CI"})
        _alr = _att_client.post("/api/v1/auth/login", json={"email": "atttest@example.com", "password": "password123", "client_type": "web"})
        _at = (_alr.json() or {}).get("access_token")
        _ah = {"Authorization": f"Bearer {_at}"}
        _att_db = SessionLocal()
        _att_user = _att_db.scalar(select(User).where(User.email == "atttest@example.com"))
        # 幂等：先清 L1 再建，避免重复运行 golden 时唯一约束冲突
        for _old in _att_db.scalars(select(Ledger).where(Ledger.external_id == "L1", Ledger.user_id == _att_user.id)).all():
            _att_db.delete(_old)
        _att_db.commit()
        _lid = "ATT-L1-i"
        insert(_att_db, Ledger, id=_lid, external_id="L1", user_id=_att_user.id, name="主账本", currency="CNY", month_start_day=1, created_at=NOW)
        insert(_att_db, LedgerMember, ledger_id=_lid, user_id=_att_user.id, role="owner")
        # 必须提交：TestClient 使用独立会话，SQLite 跨连接看不到未提交数据，
        # 否则上游 upload 解析不到账本 → 404（与本地共用内存库返回的 200 不一致）。
        _att_db.commit()

        _ATT_VOLATILE = {"file_id", "created_at"}

        def _scrub_att(v):
            if isinstance(v, list):
                return [_scrub_att(i) for i in v]
            if isinstance(v, dict):
                return {k: _scrub_att(x) for k, x in v.items() if k not in _ATT_VOLATILE}
            return v

        _att_steps = []
        def _astep(name, method, path, files=None, data=None, json_body=None, headers=None):
            fn = getattr(_att_client, method)
            kw = {}
            if files is not None:
                kw["files"] = files
            if data is not None:
                kw["data"] = data
            if json_body is not None:
                kw["json"] = json_body
            if headers:
                kw["headers"] = headers
            resp = fn(path, **kw)
            body = resp.json() if resp.status_code != 204 and resp.content else None
            _att_steps.append({"name": name, "request": {"method": method.upper(), "path": path, "json": json_body}, "status": resp.status_code, "result": _scrub_att(body) if body is not None else None})
            return resp, body

        _content = b"hello attachment content"
        _sha = _hl.sha256(_content).hexdigest()
        _astep("upload", "post", "/api/v1/attachments/upload",
               files={"file": ("seed.csv", _content, "text/csv")},
               data={"ledger_id": "L1"}, headers=_ah)
        _astep("batch_exists_hit", "post", "/api/v1/attachments/batch-exists",
               json_body={"ledger_id": "L1", "sha256_list": [_sha]}, headers=_ah)
        _astep("batch_exists_miss", "post", "/api/v1/attachments/batch-exists",
               json_body={"ledger_id": "L1", "sha256_list": ["deadbeef" * 8]}, headers=_ah)

        _ag = {"steps": _att_steps}
        _ap = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-attachments-golden.json")
        with open(_ap, "w", encoding="utf-8") as _afh:
            json.dump(_ag, _afh, ensure_ascii=False, indent=2, default=str)
            _afh.write("\n")
        print(f"wrote {len(_att_steps)} attachments steps -> {_ap}")
    except Exception as exc:
        import traceback
        print(f"[warn] attachments golden 跳过：{type(exc).__name__}: {exc}")
        traceback.print_exc()

    # ---------------- admin golden（HTTP /api/v1/admin/*，只读聚合）----------------
    # 用独立库（make_db）+ seed_scenario 保证计数干净（不被写路径 golden 污染 transactions_total）。
    # 直接调用上游函数（绕过 JWT/依赖），_admin_user 传 u1。scrub：users 的 id / created_at。
    # 注：/health 需 request.app.state.ws_manager，/users(POST) 等写操作不在对拍范围。
    try:
        from src.routers import admin as _admin_rt
        _adm_db = make_db("/tmp/parity-admin.db")
        _owner = _adm_db.get(User, "u1")
        _owner.is_admin = True
        _adm_db.commit()

        def _scrub_admin(v):
            if isinstance(v, dict):
                return {k: _scrub_admin(x) for k, x in v.items() if k not in ("id", "created_at")}
            if isinstance(v, list):
                return [_scrub_admin(x) for x in v]
            return v

        def _dump_admin(obj):
            return obj.model_dump(mode="json") if hasattr(obj, "model_dump") else obj

        _adm_calls = [
            ("overview", lambda: _admin_rt.admin_overview(_scopes=set(), _admin_user=_owner, db=_adm_db)),
            ("users", lambda: _admin_rt.list_users(q=None, status="enabled", limit=100, offset=0, _scopes=set(), _admin_user=_owner, db=_adm_db)),
        ]
        _adm_cases = []
        for _name, _fn in _adm_calls:
            try:
                _res = _fn()
                _adm_cases.append({"name": _name, "status": 200, "result": _scrub_admin(_dump_admin(_res))})
            except Exception as exc:
                _adm_cases.append({"name": _name, "status": 0, "error": f"{type(exc).__name__}: {exc}"})
        _ag = {"cases": _adm_cases}
        _ap = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-admin-golden.json")
        with open(_ap, "w", encoding="utf-8") as _afh:
            json.dump(_ag, _afh, ensure_ascii=False, indent=2, default=str)
            _afh.write("\n")
        print(f"wrote {len(_adm_cases)} admin cases -> {_ap}")
        _adm_db.close()
    except Exception as exc:
        import traceback
        print(f"[warn] admin golden 跳过：{type(exc).__name__}: {exc}")
        traceback.print_exc()

    # ---------------- workspace golden（members/invites/member-stats/shared-resources）----------------
    # 直接调用上游函数（绕过 JWT/依赖），用 make_db（内置 seed_scenario）保证种子一致。
    # 比对排除：id（本地 invites 独有）、share_url（环境派生）、joined_at（seed_scenario 未固定）；
    # income_total/expense_total 四舍五入 2 位（跨 Python/TS 浮点尾差）。列表顺序由本地 canonical 排序归一。
    try:
        from src.routers.members import list_members as _ws_list_members
        from src.routers.invites import list_invites as _ws_list_invites
        from src.routers.member_stats import get_member_stats as _ws_member_stats
        from src.routers.shared_resources import get_shared_resources as _ws_shared
        from sqlalchemy import text as _txt

        _ws_db = make_db("/tmp/parity-workspace.db")
        _owner = _ws_db.get(User, "u1")
        # 插入一条有效邀请（active 过滤：used_at IS NULL AND expires_at > now）
        _ws_db.execute(_txt(
            "INSERT INTO ledger_invites (code, ledger_id, invited_by, target_role, expires_at, used_at, created_at) "
            "VALUES (:c, :l, :i, :r, :e, :u, :ca)"
        ), {"c": "ABC234", "l": "L1-i", "i": "u1", "r": "editor",
           "e": "2099-01-01T00:00:00Z", "u": None, "ca": "2026-01-01T00:00:00Z"})
        _ws_db.commit()

        _WS_VOLATILE = {"id", "share_url", "joined_at"}
        _WS_AMOUNT = {"income_total", "expense_total"}

        def _scrub_ws(v):
            if isinstance(v, list):
                return [_scrub_ws(x) for x in v]
            if isinstance(v, dict):
                out = {}
                for k, x in v.items():
                    if k in _WS_VOLATILE:
                        continue
                    if k in _WS_AMOUNT and isinstance(x, (int, float)):
                        out[k] = round(float(x), 2)
                    else:
                        out[k] = _scrub_ws(x)
                return out
            return v

        def _dump_ws(obj):
            if isinstance(obj, list):
                return [_dump_ws(x) for x in obj]
            if hasattr(obj, "model_dump"):
                return obj.model_dump(mode="json")
            return obj

        _ws_calls = [
            ("members", lambda: _ws_list_members("L1", _scopes=set(), current_user=_owner, db=_ws_db)),
            ("invites", lambda: _ws_list_invites("L1", _scopes=set(), current_user=_owner, db=_ws_db)),
            ("member_stats", lambda: _ws_member_stats("L1", scope="all", period=None, tz_offset_minutes=0, _scopes=set(), current_user=_owner, db=_ws_db)),
            ("shared_resources", lambda: _ws_shared("L1", _scopes=set(), current_user=_owner, db=_ws_db)),
        ]
        _ws_cases = []
        for _name, _fn in _ws_calls:
            try:
                _res = _fn()
                _ws_cases.append({"name": _name, "status": 200, "result": _scrub_ws(_dump_ws(_res))})
            except Exception as exc:
                _ws_cases.append({"name": _name, "status": 0, "error": f"{type(exc).__name__}: {exc}"})
        _wg = {"cases": _ws_cases}
        _wp = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-workspace-golden.json")
        with open(_wp, "w", encoding="utf-8") as _wfh:
            json.dump(_wg, _wfh, ensure_ascii=False, indent=2, default=str)
            _wfh.write("\n")
        print(f"wrote {len(_ws_cases)} workspace cases -> {wp}")
        _ws_db.close()
    except Exception as exc:
        import traceback
        print(f"[warn] workspace golden 跳过：{type(exc).__name__}: {exc}")
        traceback.print_exc()

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(golden, fh, ensure_ascii=False, indent=2, default=str)
        fh.write("\n")

    print(f"wrote {len(golden['cases'])} cases -> {out_path}")
    if dropped_keys:
        print(f"[warn] 以下种子字段在上游表中不存在，已忽略: {sorted(dropped_keys)}")
    db.close()
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
