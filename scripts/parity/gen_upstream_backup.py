#!/usr/bin/env python3
"""生成一份真实的原版备份归档，写入 tests/fixtures/upstream-backup-sample.tar.gz。

归档结构与原版一致：tar.gz 内含 db.sqlite3（VACUUM 出的完整 SQLite 库）+ meta.json。
与 tests/integration/restore-cross.test.ts 配合：该测试优先读取本脚本产出的真归档，
本地无 Python 时回退到 node:sqlite 自建（仅结构等价，非原版 runner 产出）。

运行方式（CI 见 .github/workflows/parity.yml）：
  cd <上游仓库>
  pip install -r <workers>/scripts/parity/requirements.txt
  PYTHONPATH=. DATABASE_URL=sqlite:////tmp/upstream_backup_gen.db \
    python <workers>/scripts/parity/gen_upstream_backup.py
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone


def main() -> int:
    try:
        from src.database import Base, SessionLocal, engine  # type: ignore
        from src.models import (  # type: ignore
            Ledger, LedgerMember, ReadBudgetProjection, ReadTxProjection, User,
            UserAccountProjection, UserCategoryProjection, UserTagProjection,
        )
        from src.services.backup.tar_builder import build_targz  # type: ignore
    except ImportError as exc:
        sys.stderr.write(
            "无法导入 src.* —— 这个脚本需要上游 Python 仓库（TNT-Likely/BeeCount-Cloud）"
            "作为 PYTHONPATH。\n"
            "正确运行方式（CI 见 .github/workflows/parity.yml）：\n"
            "  cd <上游仓库>\n"
            "  pip install -r <workers>/scripts/parity/requirements.txt\n"
            "  PYTHONPATH=. DATABASE_URL=sqlite:////tmp/upstream_backup_gen.db \\\n"
            "    python <workers>/scripts/parity/gen_upstream_backup.py\n"
            f"原始错误：{type(exc).__name__}: {exc}\n"
        )
        return 2

    if not os.environ.get("DATABASE_URL"):
        os.environ["DATABASE_URL"] = "sqlite:////tmp/upstream_backup_gen.db"

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    now = datetime.now(timezone.utc).isoformat()

    # 与 restore-cross 测试断言的 sync_id 对齐：账户 a1 / 分类 c1 / 标签 g1 / 预算 b1 / 交易 t1
    db.add(User(id="u1", email="u1@example.com", password_hash="x", is_enabled=True))
    db.add(Ledger(id="L1-i", external_id="L1", user_id="u1", name="主账本",
                  currency="CNY", month_start_day=1, created_at=datetime(2026, 1, 1, 0, 0, 0)))
    db.add(LedgerMember(ledger_id="L1-i", user_id="u1", role="owner"))
    db.add(UserCategoryProjection(sync_id="c1", user_id="u1", name="餐饮",
                                  kind="expense", sort_order=1, icon="🍜"))
    db.add(UserAccountProjection(sync_id="a1", user_id="u1", name="现金",
                                 account_type="cash", currency="CNY", hidden=False))
    db.add(UserTagProjection(sync_id="g1", user_id="u1", name="出差", color="#00bcf2"))
    db.add(ReadBudgetProjection(ledger_id="L1-i", sync_id="b1", user_id="u1",
                               budget_type="monthly", category_sync_id="c1", amount=100.0,
                               period="monthly", start_day=1, enabled=True))
    db.add(ReadTxProjection(
        sync_id="t1", ledger_id="L1-i", user_id="u1", tx_type="expense", amount=38.0,
        happened_at=datetime(2026, 5, 2, 3, 30, 0), note="星巴克",
        category_sync_id="c1", category_name="餐饮", category_kind="expense",
        account_sync_id="a1", account_name="现金", currency_code="CNY", native_amount=38.0,
        tx_index=0, created_by_user_id="u1", source_change_id=1,
        exclude_from_stats=0, exclude_from_budget=0,
    ))
    db.commit()
    db.close()

    # 复刻原版备份动作：VACUUM INTO 生成 db.sqlite3（完整 SQLite 库）
    src_db = engine.url.database
    engine.dispose()
    work_dir = tempfile.mkdtemp()
    db_path = os.path.join(work_dir, "db.sqlite3")
    con = sqlite3.connect(src_db)
    con.execute(f"VACUUM INTO '{db_path}'")
    con.close()

    meta = {
        "schemaVersion": 1,
        "appVersion": "1.9.0",
        "createdAt": now,
        "userId": "u1",
        "includeAttachments": False,
    }
    with open(os.path.join(work_dir, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)

    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    out_path = os.path.join(repo_root, "tests", "fixtures", "upstream-backup-sample.tar.gz")
    build_targz(work_dir, out_path)
    sys.stderr.write(f"wrote {out_path}\n")
    shutil.rmtree(work_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
