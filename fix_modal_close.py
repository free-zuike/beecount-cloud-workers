#!/usr/bin/env python3
"""
为 modal-close 按钮添加 data-action 属性
"""
import re
import sys

def fix_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # 备份
    with open(filepath + '.modal_fix', 'w', encoding='utf-8') as f:
        content.write(content)
    
    # 为 modal-close 按钮添加事件：
    # 模式：<button class="modal-close">×</button> -> <button class="modal-close" data-action="close-modal" data-modal="XXX">×</button>
    # 但是我们需要知道它在哪个 modal 里面！
    
    # 让我们分段处理每个 modal
    
    # 先处理单个 modal-close 按钮，需要找到对应的 modal ID
    
    # 我们可以使用捕获整个 file 中每个 modal-close 按钮需要知道是在哪个 modal 内部
    
    # 1. ledgerModal
    content = re.sub(
        r'(<div id="ledgerModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="ledgerModal"',
        content,
        flags=re.DOTALL
    )
    
    # 2. createLedgerModal
    content = re.sub(
        r'(<div id="createLedgerModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="createLedgerModal"',
        content,
        flags=re.DOTALL
    )
    
    # 3. editLedgerModal
    content = re.sub(
        r'(<div id="editLedgerModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="editLedgerModal"',
        content,
        flags=re.DOTALL
    )
    
    # 4. deleteLedgerModal
    content = re.sub(
        r'(<div id="deleteLedgerModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="deleteLedgerModal"',
        content,
        flags=re.DOTALL
    )
    
    # 5. createCategoryModal
    content = re.sub(
        r'(<div id="createCategoryModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="createCategoryModal"',
        content,
        flags=re.DOTALL
    )
    
    # 6. editCategoryModal
    content = re.sub(
        r'(<div id="editCategoryModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="editCategoryModal"',
        content,
        flags=re.DOTALL
    )
    
    # 7. deleteCategoryModal
    content = re.sub(
        r'(<div id="deleteCategoryModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="deleteCategoryModal"',
        content,
        flags=re.DOTALL
    )
    
    # 8. createAccountModal
    content = re.sub(
        r'(<div id="createAccountModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="createAccountModal"',
        content,
        flags=re.DOTALL
    )
    
    # 9. editAccountModal
    content = re.sub(
        r'(<div id="editAccountModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="editAccountModal"',
        content,
        flags=re.DOTALL
    )
    
    # 10. deleteAccountModal
    content = re.sub(
        r'(<div id="deleteAccountModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="deleteAccountModal"',
        content,
        flags=re.DOTALL
    )
    
    # 11. createTagModal
    content = re.sub(
        r'(<div id="createTagModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="createTagModal"',
        content,
        flags=re.DOTALL
    )
    
    # 12. editTagModal
    content = re.sub(
        r'(<div id="editTagModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="editTagModal"',
        content,
        flags=re.DOTALL
    )
    
    # 13. deleteTagModal
    content = re.sub(
        r'(<div id="deleteTagModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="deleteTagModal"',
        content,
        flags=re.DOTALL
    )
    
    # 14. createBudgetModal
    content = re.sub(
        r'(<div id="createBudgetModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="createBudgetModal"',
        content,
        flags=re.DOTALL
    )
    
    # 15. editBudgetModal
    content = re.sub(
        r'(<div id="editBudgetModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="editBudgetModal"',
        content,
        flags=re.DOTALL
    )
    
    # 16. deleteBudgetModal
    content = re.sub(
        r'(<div id="deleteBudgetModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="deleteBudgetModal"',
        content,
        flags=re.DOTALL
    )
    
    # 17. settingsModal
    content = re.sub(
        r'(<div id="settingsModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="settingsModal"',
        content,
        flags=re.DOTALL
    )
    
    # 18. createTxModal
    content = re.sub(
        r'(<div id="createTxModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="createTxModal"',
        content,
        flags=re.DOTALL
    )
    
    # 19. editTxModal
    content = re.sub(
        r'(<div id="editTxModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="editTxModal"',
        content,
        flags=re.DOTALL
    )
    
    # 20. confirmClearDataModal
    content = re.sub(
        r'(<div id="confirmClearDataModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="confirmClearDataModal"',
        content,
        flags=re.DOTALL
    )
    
    # 21. importModal
    content = re.sub(
        r'(<div id="importModal"[^>]*>.*?<button class="modal-close")',
        r'\1 data-action="close-modal" data-modal="importModal"',
        content,
        flags=re.DOTALL
    )
    
    # 现在还需要处理 tx type buttons!
    # type-selector 的按钮:
    # onclick="selectTxType('expense')" 等的按钮需要替换为 data-action="select-tx-type" data-type="expense"
    
    content = re.sub(
        r'(class="type-btn expense" data-type="expense")',
        r'\1 data-action="select-tx-type"',
        content
    )
    
    content = re.sub(
        r'(class="type-btn income" data-type="income")',
        r'\1 data-action="select-tx-type"',
        content
    )
    
    content = re.sub(
        r'(class="type-btn expense" data-type="expense" data-action="select-edit-tx-type")',
        r'\1',
        content
    )
    
    # edit 的:
    content = re.sub(
        r'(class="type-btn income" data-type="income" data-action="select-edit-tx-type")',
        r'\1',
        content
    )
    
    # 写回
    with open(filepath, 'w', encoding='utf-8') as f:
        content = f.write(content)
    
    print("Modal-close 按钮 data-action 属性已添加！")

if __name__ == '__main__':
    fix_file(sys.argv[1] if len(sys.argv) > 1 else '/workspace/beecount-cloud-workers/src/index.ts')
