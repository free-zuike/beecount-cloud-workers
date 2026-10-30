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

import asyncio
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

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
    db = SessionLocal()
    dropped_keys: set[str] = set()

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
            or getattr(file_tools, tool)
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

    def step(name, thunk):
        try:
            res = thunk()
            state["last_raw"] = res
            if name == "create" and isinstance(res, dict):
                state["new_id"] = res.get("sync_id") or res.get("id")
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
    golden["scenario"] = scenario

    # ---------------- REST 只读计算 golden（summary / budgets-usage / rates / gallery）--------
    # 这些上游实现分布在 routers/read/*，workers 在 routes/read.ts / summary.ts 里**独立重写**
    # 了同样的 SQL/计算（且带"对齐上游"注释），是最可能重演 MCP 那几类"早期错误对齐"的地方。
    # 单独产一份 golden，本地用真实路由做 HTTP 级差分（见 tests/rest-differential.test.ts）。
    # 隔离在 try 里：上游路由若因依赖缺失 import 失败，不影响主管线的 golden。
    rest_golden = {"now": NOW.isoformat(), "cases": []}
    try:
        from src.routers.read.summary import get_summary  # type: ignore
        from src.routers.read.ledgers import list_budgets_usage  # type: ignore
        from src.routers.read.rates import list_exchange_rate_overrides  # type: ignore
        from src.routers.read.attachment_gallery import list_gallery_attachments  # type: ignore

        def dump_model(obj):
            if hasattr(obj, "model_dump"):
                return obj.model_dump(mode="json")
            return obj

        rest_calls = [
            ("get_summary", dict(ledger_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("get_summary", dict(ledger_id="L3", _scopes=set(), current_user=owner, db=db)),
            ("list_budgets_usage", dict(ledger_external_id="L1", _scopes=set(), current_user=owner, db=db)),
            ("list_budgets_usage", dict(ledger_external_id="L3", _scopes=set(), current_user=owner, db=db)),
            ("list_exchange_rate_overrides", dict(_scopes=set(), current_user=owner, db=db)),
        ]
        for tool, args in rest_calls:
            fn = {"get_summary": get_summary, "list_budgets_usage": list_budgets_usage,
                   "list_exchange_rate_overrides": list_exchange_rate_overrides,
                   "list_gallery_attachments": list_gallery_attachments}[tool]
            try:
                res = dump_model(fn(**args))
                rest_golden["cases"].append(
                    {"tool": tool, "args": {k: v for k, v in args.items() if k not in ("db", "_scopes", "current_user")},
                     "result": normalize(res)})
            except Exception as exc:
                rest_golden["cases"].append(
                    {"tool": tool, "args": {k: v for k, v in args.items() if k not in ("db", "_scopes", "current_user")},
                     "error": f"{type(exc).__name__}: {exc}"})
        rest_path = os.path.join(os.path.dirname(os.path.abspath(out_path)), "upstream-rest-golden.json")
        with open(rest_path, "w", encoding="utf-8") as rfh:
            json.dump(rest_golden, rfh, ensure_ascii=False, indent=2, default=str)
            rfh.write("\n")
        print(f"wrote {len(rest_golden['cases'])} rest cases -> {rest_path}")
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
