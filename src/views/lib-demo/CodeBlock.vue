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

/** 关键字表:供正则第 7 组按整词匹配着色 */
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

/** 转义 & < >:高亮结果要经 v-html 注入,必须转义在前,否则源码里的标签会破坏 DOM */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 捕获组顺序即优先级;组序号与下方 html() 里 groups 的解构一一对应
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

// 高亮结果:逐段替换为带 tk-* 类名的 span,未命中任何分支的原文原样保留
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
// "已复制"反馈的复位计时器;用普通变量即可,无需响应式
let copyTimer = 0

/** 复制源码:优先 Clipboard API,非安全上下文下退化为"选中正文" */
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
  <!-- 代码块卡片:标题栏(标题 + 复制按钮)+ 高亮正文 -->
  <figure class="code-block">
    <figcaption class="code-head">
      <span class="code-title">{{ title }}</span>
      <button class="code-copy" type="button" @click="copy">
        {{ copied ? '已复制 ✓' : '复制' }}
      </button>
    </figcaption>
    <!-- v-html 注入高亮结果;data-code=标题,供复制降级时按标题定位正文 -->
    <pre class="code-body" :data-lang="lang"><code :data-code="title" v-html="html"></code></pre>
  </figure>
</template>

<style scoped>
/* 卡片容器 */
.code-block {
  margin: 0;
  border: 1px solid rgb(121 230 202 / 16%);
  border-radius: 8px;
  background: #060f14;
  overflow: hidden;
}

/* 顶部标题栏 */
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
  font:
    600 10px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.06em;
}

/* 复制按钮 */
.code-copy {
  padding: 3px 9px;
  color: #9fe0cf;
  border: 1px solid rgb(121 230 202 / 28%);
  border-radius: 4px;
  background: transparent;
  font:
    500 10px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  cursor: pointer;
  transition: all 0.15s ease;
}

.code-copy:hover {
  color: #061014;
  background: #7de6ca;
  border-color: #7de6ca;
}

/* 代码正文与自定义滚动条 */
.code-body {
  margin: 0;
  padding: 10px 12px;
  max-height: 420px;
  overflow: auto;
  color: #cfe9e2;
  font:
    400 11px/1.62 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
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

/* 语法着色:tk-* 由 v-html 注入,不在本组件作用域内,须用 :deep 穿透 */
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
