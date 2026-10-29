#!/usr/bin/env python
"""上游 MCP 只读工具的 golden 输出转储器（运行时差分的"上游一侧"）。

在**有 Python 且装好上游依赖**的机器上运行：

    cd <上游仓库根>
    python <本文件> ../beecount-cloud-workers/tests/fixtures/upstream-golden.json

产出后，本地 `tests/mcp-differential.test.ts` 会用同一份 fixture 跑同样的调用矩阵并逐字段比对。
两侧都不依赖 HTTP / MCP transport，直接调函数，所以差异只可能来自业务语义。

设计要点：
- 夹具数据写死在本文件里（与 tests/mcp-differential.test.ts 的 seed 一一对应），
  改动任何一侧都必须同步另一侧，否则测试会以"golden 陈旧"失败——这是刻意的。
- 固定 NOW / 时区，避免时间漂移导致的假差异。
- 输出做规范化（键排序、float 保留原值、datetime 转 isoformat），
  本地侧用同样的规范化后再比。
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

# 固定时间基准，保证两侧一致
NOW = datetime(2026, 5, 20, 4, 0, 0, tzinfo=timezone.utc)


def main(out_path: str) -> int:
    os.environ.setdefault("SCHEDULER_TIMEZONE", "Asia/Shanghai")
    # 上游 config.settings.database_url 默认 sqlite:///./beecount.db，支持 sqlite 方言
    os.environ.setdefault("DATABASE_URL", "sqlite:////tmp/parity.db")

    # 延迟导入：让 --help/语法错误不依赖上游依赖
    # 注意：上游模块布局是 src/database.py（不是 src/db/session.py）
    from src.database import Base, SessionLocal, engine  # type: ignore
    from src.mcp import read_tools  # type: ignore
    from src.models import (  # type: ignore
        Account, Category, Ledger, LedgerMember, Transaction, User,
    )

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    # ---------------- 夹具（必须与 TS 侧一致） ----------------
    owner = User(id="u1", email="u1@example.com", password_hash="x", is_enabled=True)
    other = User(id="u2", email="u2@example.com", password_hash="x", is_enabled=True)
    db.add_all([owner, other])

    led = Ledger(id="L1-i", external_id="L1", user_id="u1", name="主账本",
                 currency="CNY", month_start_day=1, created_at=NOW)
    shared = Ledger(id="L2-i", external_id="L2", user_id="u2", name="共享账本",
                    currency="USD", month_start_day=1, created_at=NOW)
    db.add_all([led, shared])
    db.add_all([
        LedgerMember(ledger_id="L1-i", user_id="u1", role="owner"),
        LedgerMember(ledger_id="L2-i", user_id="u1", role="editor"),
        LedgerMember(ledger_id="L2-i", user_id="u2", role="owner"),
    ])

    cat_food = Category(sync_id="c1", ledger_id="L1-i", user_id="u1", name="餐饮",
                        kind="expense", sort_order=1, icon="🍜")
    cat_salary = Category(sync_id="c2", ledger_id="L1-i", user_id="u1", name="工资",
                          kind="income", sort_order=2)
    acc_cash = Account(sync_id="a1", ledger_id="L1-i", user_id="u1", name="现金",
                       account_type="cash", currency="CNY", hidden=False)
    acc_bank = Account(sync_id="a2", ledger_id="L1-i", user_id="u1", name="招行",
                       account_type="bank", currency="CNY", hidden=None)
    db.add_all([cat_food, cat_salary, acc_cash, acc_bank])

    def tx(sync_id, kind, amount, happened, **kw):
        return Transaction(
            sync_id=sync_id, ledger_id="L1-i", user_id="u1", tx_type=kind,
            amount=amount, happened_at=happened, created_by_user_id="u1",
            exclude_from_stats=kw.get("exclude_from_stats", False),
            exclude_from_budget=kw.get("exclude_from_budget", False),
            category_sync_id=kw.get("category_sync_id"),
            account_sync_id=kw.get("account_sync_id"),
            currency_code=kw.get("currency_code", "CNY"),
            native_amount=kw.get("native_amount"),
            note=kw.get("note"),
            tags_csv=kw.get("tags_csv"),
        )

    db.add_all([
        tx("t1", "expense", 38.0, datetime(2026, 5, 2, 3, 30, tzinfo=timezone.utc),
           category_sync_id="c1", account_sync_id="a1", note="星巴克"),
        tx("t2", "expense", 12.5, datetime(2026, 5, 2, 3, 30, tzinfo=timezone.utc),
           category_sync_id="c1", account_sync_id="a1", note="同秒第二笔"),
        tx("t3", "income", 8000.0, datetime(2026, 5, 10, 1, 0, tzinfo=timezone.utc),
           category_sync_id="c2", account_sync_id="a2"),
        tx("t4", "expense", 100.0, datetime(2026, 5, 11, 2, 0, tzinfo=timezone.utc),
           category_sync_id="c1", account_sync_id="a1", exclude_from_stats=True),
        tx("t5", "expense", 20.0, datetime(2026, 5, 12, 2, 0, tzinfo=timezone.utc),
           category_sync_id="c1", account_sync_id="a1", exclude_from_budget=True),
        tx("t6", "expense", 7.5, datetime(2026, 5, 13, 2, 0, tzinfo=timezone.utc),
           currency_code="USD", native_amount=1.03, account_sync_id="a1"),
        tx("t7", "expense", 30.0, datetime(2026, 5, 14, 2, 0, tzinfo=timezone.utc),
           tags_csv="出差,客户", category_sync_id="c1", account_sync_id="a1"),
    ])
    db.commit()

    calls = [
        ("list_transactions", {"ledger_id": "L1", "limit": 50}),
        ("list_transactions", {"ledger_id": "L1", "date_from": "2026-05-02", "date_to": "2026-05-02"}),
        ("list_transactions", {"ledger_id": "L1", "min_amount": 20, "max_amount": 100}),
        ("list_transactions", {"ledger_id": "L1", "tag_ids": ["出差"]}),
        ("get_transaction", {"sync_id": "t1"}),
        ("list_categories", {"ledger_id": "L1"}),
        ("list_accounts", {"ledger_id": "L1"}),
        ("list_tags", {"ledger_id": "L1"}),
        ("list_budgets", {"ledger_id": "L1"}),
        ("get_ledger_stats", {"ledger_id": "L1"}),
        ("get_analytics_summary", {"ledger_id": "L1", "scope": "month", "period": "2026-05"}),
        ("search", {"q": "星巴克", "limit": 20}),
    ]

    def normalize(value):
        if isinstance(value, datetime):
            return value.replace(tzinfo=value.tzinfo or timezone.utc).isoformat()
        if isinstance(value, dict):
            return {k: normalize(v) for k, v in sorted(value.items())}
        if isinstance(value, (list, tuple)):
            return [normalize(v) for v in value]
        return value

    golden = {"now": NOW.isoformat(), "cases": []}
    for tool, args in calls:
        fn = getattr(read_tools, tool)
        try:
            out = fn(owner, **args)
        except Exception as exc:  # 上游报错也是一条契约
            golden["cases"].append({"tool": tool, "args": args,
                                    "error": f"{type(exc).__name__}: {exc}"})
            continue
        golden["cases"].append({"tool": tool, "args": args, "result": normalize(out)})

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(golden, fh, ensure_ascii=False, indent=2, default=str)
        fh.write("\n")
    print(f"wrote {len(golden['cases'])} cases -> {out_path}")
    db.close()
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
