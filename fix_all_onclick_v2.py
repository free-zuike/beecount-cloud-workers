#!/usr/bin/env python3
"""
彻底移除所有 onclick 属性，确保没有遗漏
"""
import re
import sys

def fix_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 备份
    with open(filepath + '.final_fix2', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"备份创建: {filepath}.final_fix2")
    
    # 全局替换：移除所有 onclick="..." 属性
    # 先统计有多少个
    onclick_count = content.count('onclick="')
    print(f"找到 {onclick_count} 个 onclick 属性")
    
    # 现在移除所有 onclick="..." 并处理常见模式
    # 模式 1: onclick="closeModal('xxx')" -> data-action="close-modal" data-modal="xxx"
    content = re.sub(
        r'onclick="closeModal\(\'([^\']+)\'\)"',
        r'data-action="close-modal" data-modal="\1"',
        content
    )
    
    # 模式 2: onclick="closeModal('xxx')" 但可能有其他空格
    content = re.sub(
        r'onclick="closeModal\(\'([^\']+)\'\s*\)"',
        r'data-action="close-modal" data-modal="\1"',
        content
    )
    
    # 模式 3: onclick="showModal('xxx')"
    content = re.sub(
        r'onclick="showModal\(\'([^\']+)\'\)"',
        r'data-action="show-modal" data-modal="\1"',
        content
    )
    
    # 模式 4: onclick="showModal('xxx', this)"
    content = re.sub(
        r'onclick="showModal\(\'([^\']+)\',\s*this\s*\)"',
        r'data-action="show-modal" data-modal="\1"',
        content
    )
    
    # 模式 5: onclick="selectTxType('xxx')"
    content = re.sub(
        r'onclick="selectTxType\(\'([^\']+)\'\)"',
        r'data-action="select-tx-type" data-type="\1"',
        content
    )
    
    # 模式 6: onclick="selectEditTxType('xxx')"
    content = re.sub(
        r'onclick="selectEditTxType\(\'([^\']+)\'\)"',
        r'data-action="select-edit-tx-type" data-type="\1"',
        content
    )
    
    # 模式 7: onclick="setQuickAmount(1000)"
    content = re.sub(
        r'onclick="setQuickAmount\((\d+)\)"',
        r'data-action="set-quick-amount" data-amount="\1"',
        content
    )
    
    # 模式 8: onclick="showSettingsSection('xxx', this)"
    content = re.sub(
        r'onclick="showSettingsSection\(\'([^\']+)\',\s*this\s*\)"',
        r'data-action="show-settings-section" data-section="\1"',
        content
    )
    
    # 模式 9: onclick="deleteLedger(this)"
    content = re.sub(
        r'onclick="deleteLedger\(\s*this\s*\)"',
        r'data-action="delete-ledger"',
        content
    )
    
    # 模式 10: onclick="editLedger(this)"
    content = re.sub(
        r'onclick="editLedger\(\s*this\s*\)"',
        r'data-action="edit-ledger"',
        content
    )
    
    # 模式 11: onclick="deleteTransaction(this)"
    content = re.sub(
        r'onclick="deleteTransaction\(\s*this\s*\)"',
        r'data-action="delete-transaction"',
        content
    )
    
    # 模式 12: onclick="editTransaction(this)"
    content = re.sub(
        r'onclick="editTransaction\(\s*this\s*\)"',
        r'data-action="edit-transaction"',
        content
    )
    
    # 模式 13: onclick="editCategory(this)"
    content = re.sub(
        r'onclick="editCategory\(\s*this\s*\)"',
        r'data-action="edit-category"',
        content
    )
    
    # 模式 14: onclick="deleteCategory(this)"
    content = re.sub(
        r'onclick="deleteCategory\(\s*this\s*\)"',
        r'data-action="delete-category"',
        content
    )
    
    # 模式 15: onclick="editAccount(this)"
    content = re.sub(
        r'onclick="editAccount\(\s*this\s*\)"',
        r'data-action="edit-account"',
        content
    )
    
    # 模式 16: onclick="deleteAccount(this)"
    content = re.sub(
        r'onclick="deleteAccount\(\s*this\s*\)"',
        r'data-action="delete-account"',
        content
    )
    
    # 模式 17: onclick="editTag(this)"
    content = re.sub(
        r'onclick="editTag\(\s*this\s*\)"',
        r'data-action="edit-tag"',
        content
    )
    
    # 模式 18: onclick="deleteTag(this)"
    content = re.sub(
        r'onclick="deleteTag\(\s*this\s*\)"',
        r'data-action="delete-tag"',
        content
    )
    
    # 模式 19: onclick="editBudget(this)"
    content = re.sub(
        r'onclick="editBudget\(\s*this\s*\)"',
        r'data-action="edit-budget"',
        content
    )
    
    # 模式 20: onclick="deleteBudget(this)"
    content = re.sub(
        r'onclick="deleteBudget\(\s*this\s*\)"',
        r'data-action="delete-budget"',
        content
    )
    
    # 模式 21: onclick="revokeDevice(this)"
    content = re.sub(
        r'onclick="revokeDevice\(\s*this\s*\)"',
        r'data-action="revoke-device"',
        content
    )
    
    # 模式 22: onclick="startImport()"
    content = re.sub(
        r'onclick="startImport\(\s*\)"',
        r'data-action="start-import"',
        content
    )
    
    # 最后：检查并移除任何剩余的 onclick 属性（兜底）
    # 这是最彻底的 - 移除所有 onclick="..."
    # 但我们要小心不要破坏其他属性
    remaining_onclick_count = content.count('onclick="')
    print(f"首次替换后剩余 {remaining_onclick_count} 个 onclick 属性")
    
    # 如果还有剩余，用更激进的方式处理
    if remaining_onclick_count > 0:
        print("使用兜底方案移除所有剩余 onclick 属性")
        # 移除所有 onclick="xxx"
        # 这个正则会匹配 onclick="任意内容"，注意要处理嵌套引号？
        # 但在我们的用例中应该是安全的
        content = re.sub(r'\s+onclick="[^"]*"', '', content)
    
    # 最终检查
    final_onclick_count = content.count('onclick="')
    print(f"最终剩余 {final_onclick_count} 个 onclick 属性")
    
    # 写回
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    if final_onclick_count == 0:
        print("🎉 所有 onclick 属性已成功移除！")
    else:
        print(f"⚠️ 还有 {final_onclick_count} 个 onclick 属性")

if __name__ == '__main__':
    fix_file(sys.argv[1] if len(sys.argv) > 1 else '/workspace/beecount-cloud-workers/src/index.ts')
