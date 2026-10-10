import { describe, expect, it } from 'vitest'
import { renderMarkdownLite } from './AboutDialog'

describe('AboutDialog markdown rendering', () => {
  it('escapes active HTML and attribute-breaking quotes from release notes', () => {
    const html = renderMarkdownLite('<script>alert(1)</script> [link](https://example.com/\" onmouseover=\"alert(1))')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('onmouseover="')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&quot;')
  })
})
