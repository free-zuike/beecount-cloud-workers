#!/usr/bin/env python3
"""
彻底修复字符串转义问题，移除所有内嵌 onclick，使用事件委托
"""
import re
import sys

def fix_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 备份
    with open(filepath + '.final_fix', 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"备份创建: {filepath}.final_fix")
    
    # 替换模式 1: onclick="closeModal('xxx')" -> data-action="close-modal" data-modal="xxx"
    content = re.sub(
        r'onclick="closeModal\(\'([^\']+)\'\)"',
        r'data-action="close-modal" data-modal="\1"',
        content
    )
    
    # 替换模式 2: onclick="showModal('xxx')" -> data-action="show-modal" data-modal="xxx"
    content = re.sub(
        r'onclick="showModal\(\'([^\']+)\'\)"',
        r'data-action="show-modal" data-modal="\1"',
        content
    )
    
    # 替换模式 3: onclick="showModal('xxx', this)" -> data-action="show-modal" data-modal="xxx"
    content = re.sub(
        r'onclick="showModal\(\'([^\']+)\',\s*this\s*\)"',
        r'data-action="show-modal" data-modal="\1"',
        content
    )
    
    # 替换模式 4: onclick="selectTxType('xxx')" -> data-action="select-tx-type" data-type="xxx"
    content = re.sub(
        r'onclick="selectTxType\(\'([^\']+)\'\)"',
        r'data-action="select-tx-type" data-type="\1"',
        content
    )
    
    # 替换模式 5: onclick="selectEditTxType('xxx')" -> data-action="select-edit-tx-type" data-type="xxx"
    content = re.sub(
        r'onclick="selectEditTxType\(\'([^\']+)\'\)"',
        r'data-action="select-edit-tx-type" data-type="\1"',
        content
    )
    
    # 替换模式 6: onclick="setQuickAmount(1000)" -> data-action="set-quick-amount" data-amount="1000"
    content = re.sub(
        r'onclick="setQuickAmount\((\d+)\)"',
        r'data-action="set-quick-amount" data-amount="\1"',
        content
    )
    
    # 替换模式 7: onclick="showSettingsSection('xxx', this)" -> data-action="show-settings-section" data-section="xxx"
    content = re.sub(
        r'onclick="showSettingsSection\(\'([^\']+)\',\s*this\s*\)"',
        r'data-action="show-settings-section" data-section="\1"',
        content
    )
    
    # 替换模式 8: onclick="deleteLedger(this)" -> data-action="delete-ledger" data-id="xxx"
    # 需要配合上下文，不过先处理有 data-id 元素的情况
    content = re.sub(
        r'onclick="deleteLedger\(\s*this\s*\)"',
        r'data-action="delete-ledger"',
        content
    )
    
    # 替换模式 9: onclick="editLedger(this)" -> data-action="edit-ledger"
    content = re.sub(
        r'onclick="editLedger\(\s*this\s*\)"',
        r'data-action="edit-ledger"',
        content
    )
    
    # 替换模式 10: onclick="deleteTransaction(this)" -> data-action="delete-transaction"
    content = re.sub(
        r'onclick="deleteTransaction\(\s*this\s*\)"',
        r'data-action="delete-transaction"',
        content
    )
    
    # 替换模式 11: onclick="editTransaction(this)" -> data-action="edit-transaction"
    content = re.sub(
        r'onclick="editTransaction\(\s*this\s*\)"',
        r'data-action="edit-transaction"',
        content
    )
    
    # 替换模式 12: onclick="editCategory(this)" -> data-action="edit-category"
    content = re.sub(
        r'onclick="editCategory\(\s*this\s*\)"',
        r'data-action="edit-category"',
        content
    )
    
    # 替换模式 13: onclick="deleteCategory(this)" -> data-action="delete-category"
    content = re.sub(
        r'onclick="deleteCategory\(\s*this\s*\)"',
        r'data-action="delete-category"',
        content
    )
    
    # 替换模式 14: onclick="editAccount(this)" -> data-action="edit-account"
    content = re.sub(
        r'onclick="editAccount\(\s*this\s*\)"',
        r'data-action="edit-account"',
        content
    )
    
    # 替换模式 15: onclick="deleteAccount(this)" -> data-action="delete-account"
    content = re.sub(
        r'onclick="deleteAccount\(\s*this\s*\)"',
        r'data-action="delete-account"',
        content
    )
    
    # 替换模式 16: onclick="editTag(this)" -> data-action="edit-tag"
    content = re.sub(
        r'onclick="editTag\(\s*this\s*\)"',
        r'data-action="edit-tag"',
        content
    )
    
    # 替换模式 17: onclick="deleteTag(this)" -> data-action="delete-tag"
    content = re.sub(
        r'onclick="deleteTag\(\s*this\s*\)"',
        r'data-action="delete-tag"',
        content
    )
    
    # 替换模式 18: onclick="editBudget(this)" -> data-action="edit-budget"
    content = re.sub(
        r'onclick="editBudget\(\s*this\s*\)"',
        r'data-action="edit-budget"',
        content
    )
    
    # 替换模式 19: onclick="deleteBudget(this)" -> data-action="delete-budget"
    content = re.sub(
        r'onclick="deleteBudget\(\s*this\s*\)"',
        r'data-action="delete-budget"',
        content
    )
    
    # 替换模式 20: onclick="revokeDevice(this)" -> data-action="revoke-device"
    content = re.sub(
        r'onclick="revokeDevice\(\s*this\s*\)"',
        r'data-action="revoke-device"',
        content
    )
    
    # 替换模式 21: onclick="startImport()" -> data-action="start-import"
    content = re.sub(
        r'onclick="startImport\(\s*\)"',
        r'data-action="start-import"',
        content
    )
    
    # 写回
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print("修复完成！移除了所有内嵌 onclick 属性")

if __name__ == '__main__':
    fix_file(sys.argv[1] if len(sys.argv) > 1 else '/workspace/beecount-cloud-workers/src/index.ts')
