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

import json
import os
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

    from src.database import Base, SessionLocal, engine  # type: ignore
    from src.mcp.tools import read_tools  # type: ignore
    from src.models import (  # type: ignore
        Ledger, LedgerMember, ReadTxProjection, User, UserAccountProjection,
        UserCategoryProjection, UserTagProjection,
    )

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

    add(UserCategoryProjection, sync_id="c1", ledger_id="L1-i", user_id="u1",
        name="餐饮", kind="expense", sort_order=1, icon="🍜")
    add(UserCategoryProjection, sync_id="c2", ledger_id="L1-i", user_id="u1",
        name="工资", kind="income", sort_order=2)
    add(UserAccountProjection, sync_id="a1", ledger_id="L1-i", user_id="u1",
        name="现金", account_type="cash", currency="CNY", hidden=False)
    add(UserAccountProjection, sync_id="a2", ledger_id="L1-i", user_id="u1",
        name="招行", account_type="bank", currency="CNY", hidden=None)
    add(UserTagProjection, sync_id="g1", ledger_id="L1-i", user_id="u1",
        name="出差", color="#00bcf2")
    add(UserTagProjection, sync_id="g2", ledger_id="L1-i", user_id="u1",
        name="客户", color="#ff9800")

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
    calls = [
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
        fn = getattr(read_tools, tool)
        try:
            result = normalize(fn(owner, **args))
            golden["cases"].append({"tool": tool, "args": args, "result": result})
        except Exception as exc:  # 上游报错本身也是一条契约
            golden["cases"].append({"tool": tool, "args": args,
                                    "error": f"{type(exc).__name__}: {exc}"})

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
