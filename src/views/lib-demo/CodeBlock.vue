<script setup lang="ts">
/**
 * 示例代码块:轻量语法高亮 + 一键复制。
 *
 * 不做完整词法分析:先转义 HTML,再用一条带分支的正则一次性切分
 * (注释 / 字符串 / 数字 / 关键字 / 调用名),顺序即优先级。
 * 之所以要转义在前,是因为高亮结果要用 v-html 注入。
 */
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 源码文本 */
    code: string
    /** 卡片标题(一般是文件名或用途) */
    title?: string
    /** 右上角语言标签 */
    lang?: string
  }>(),
  { title: '示例代码', lang: 'ts' },
)

const KEYWORDS = [
  'const',
  'let',
  'var',
  'new',
  'import',
  'from',
  'export',
  'default',
  'async',
  'await',
  'function',
  'return',
  'if',
  'else',
  'for',
  'of',
  'in',
  'while',
  'class',
  'extends',
  'interface',
  'type',
  'enum',
  'void',
  'null',
  'undefined',
  'true',
  'false',
  'this',
  'try',
  'catch',
  'throw',
  'typeof',
  'as',
  'readonly',
  'public',
  'private',
  'static',
  'implements',
  'super',
]

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const PATTERN = new RegExp(
  [
    '(\\/\\/[^\\n]*)', // 1 行注释
    '(\\/\\*[\\s\\S]*?\\*\\/)', // 2 块注释
    "('(?:[^'\\\\\\n]|\\\\.)*')", // 3 单引号串
    '("(?:[^"\\\\\\n]|\\\\.)*")', // 4 双引号串
    '(`(?:[^`\\\\]|\\\\.)*`)', // 5 模板串
    '(\\b\\d+(?:\\.\\d+)*\\b)', // 6 数字
    `(\\b(?:${KEYWORDS.join('|')})\\b)`, // 7 关键字
    '(&gt;=&gt;)', // 8 箭头函数(> 已被转义)
    '([A-Za-z_$][\\w$]*)(?=\\()', // 9 调用名
  ].join('|'),
  'g',
)

const html = computed(() =>
  escapeHtml(props.code).replace(PATTERN, (match, ...groups: Array<string | undefined>) => {
    const [lineComment, blockComment, str1, str2, tpl, num, keyword, arrow, call] = groups
    if (lineComment || blockComment) return `<span class="tk-comment">${match}</span>`
    if (str1 || str2 || tpl) return `<span class="tk-string">${match}</span>`
    if (num) return `<span class="tk-number">${match}</span>`
    if (keyword) return `<span class="tk-keyword">${match}</span>`
    if (arrow) return `<span class="tk-op">${match}</span>`
    if (call) return `<span class="tk-call">${match}</span>`
    return match
  }),
)

const copied = ref(false)
let copyTimer = 0

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.code)
  } catch {
    // 非安全上下文(非 localhost / 非 https)下剪贴板不可用,退化成"选中文本"
    const range = document.createRange()
    const node = document.querySelector(`[data-code="${props.title}"]`)
    if (node) {
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    return
  }
  copied.value = true
  window.clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copied.value = false
  }, 1400)
}
</script>

<template>
  <figure class="code-block">
    <figcaption class="code-head">
      <span class="code-title">{{ title }}</span>
      <button class="code-copy" type="button" @click="copy">
        {{ copied ? '已复制 ✓' : '复制' }}
      </button>
    </figcaption>
    <pre class="code-body" :data-lang="lang"><code :data-code="title" v-html="html"></code></pre>
  </figure>
</template>

<style scoped>
.code-block {
  margin: 0;
  border: 1px solid rgb(121 230 202 / 16%);
  border-radius: 8px;
  background: #060f14;
  overflow: hidden;
}

.code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 9px;
  border-bottom: 1px solid rgb(121 230 202 / 12%);
  background: rgb(16 36 42 / 62%);
}

.code-title {
  color: #7de6ca;
  font: 600 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 0.06em;
}

.code-copy {
  padding: 3px 9px;
  color: #9fe0cf;
  border: 1px solid rgb(121 230 202 / 28%);
  border-radius: 4px;
  background: transparent;
  font: 500 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  cursor: pointer;
  transition: all 0.15s ease;
}

.code-copy:hover {
  color: #061014;
  background: #7de6ca;
  border-color: #7de6ca;
}

.code-body {
  margin: 0;
  padding: 10px 12px;
  max-height: 420px;
  overflow: auto;
  color: #cfe9e2;
  font: 400 11px/1.62 ui-monospace, SFMono-Regular, Consolas, monospace;
  tab-size: 2;
  white-space: pre;
}

.code-body::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.code-body::-webkit-scrollbar-thumb {
  background: rgb(121 230 202 / 22%);
  border-radius: 4px;
}

:deep(.tk-comment) {
  color: #4e7a74;
  font-style: italic;
}

:deep(.tk-string) {
  color: #e6c884;
}

:deep(.tk-number) {
  color: #d79bd2;
}

:deep(.tk-keyword) {
  color: #6ec7ff;
}

:deep(.tk-op) {
  color: #6ec7ff;
}

:deep(.tk-call) {
  color: #7de6ca;
}
</style>
