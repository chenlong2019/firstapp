/**
 * 注释-only 改动校验器。
 *
 * 用途：证明"某批文件只加了注释、未动代码"。做法是把两边文件都剥掉注释、压掉所有
 * 空白后逐文件比对——只要注释之外的内容有一个字符不同，就会报出来。
 *
 * 用法：
 *   node scripts/check-comment-only.mjs <基线目录> <当前目录>
 *
 * 例：node scripts/check-comment-only.mjs /tmp/anno-baseline src/race-scene
 *
 * 退出码：0 = 全部一致；1 = 有文件被改动或增删。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 剥离行注释与块注释，保留字符串字面量内部的原文。
 *
 * 不做正则字面量识别（`/a\/b/` 之类）：本项目里没有形如 `//` 的正则，且两边用
 * 同一套规则处理，即使偶有误判也对称，不影响"是否一致"的结论。
 */
/**
 * 正则字面量的起止判断：只有"上一个有意义字符"是运算符/左括号等位置时，`/` 才是正则的开头
 * （否则是除号）。漏掉这条会栽在形如 /REVISION\s*=\s*['"`]186/ 的正则上——里面的引号/反引号
 * 会把剥离器带进字符串状态，后面所有注释都漏剥（校验器就成了摆设）。
 *
 * ⚠️ 故意**不包含** `<`：Vue 模板里 `</div>` 遍地都是，若把 `<` 当正则前缀，`</` 会被误判成
 * 正则开头并一路吞到下一个 `/`，整个文件的判定就废了。
 */
const REGEX_PREFIX_CHARS = '([{,;:=!&|?+-*%~^>'
const REGEX_PREFIX_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await',
])

/**
 * 剥离注释，保留字符串与正则字面量的原文。
 *
 * 处理顺序：行注释 / 块注释 / Vue 的 `<!-- -->` / 模板字面量（含 `${}` 嵌套）/ 普通字符串 / 正则字面量。
 */
const strip = (src) => {
  let out = ''
  let i = 0
  const n = src.length
  // code | sq | dq | tpl | line | block | html | regex
  let state = 'code'
  let braceDepth = 0
  const tplStack = [] // 每个元素是进入 ${ 之前的 braceDepth
  let inClass = false // 正则字符类 [...] 内部：此处的 / 不表示正则结束
  let prevSig = '' // 上一个有意义字符（判断 / 是正则还是除号）
  let lastWord = '' // 上一个标识符（return / typeof 之后的 / 是正则）
  const next = () => src[i + 1] ?? ''
  const isRegexStart = () => prevSig === '' || REGEX_PREFIX_CHARS.includes(prevSig) || REGEX_PREFIX_WORDS.has(lastWord)
  const noteSig = (ch) => {
    if (/\s/.test(ch)) return
    prevSig = ch
    if (/[A-Za-z_$]/.test(ch)) lastWord += ch
    else lastWord = ''
  }
  while (i < n) {
    const c = src[i]
    if (state === 'code') {
      if (c === '/' && next() === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && next() === '*') { state = 'block'; i += 2; continue }
      // Vue 模板里的 <!-- --> 注释也要剥掉，否则 .vue 文件会被误判
      if (c === '<' && src.startsWith('<!--', i)) { state = 'html'; i += 4; continue }
      if (c === '/' && isRegexStart()) { state = 'regex'; inClass = false; out += c; i++; noteSig(c); continue }
      if (c === '{') braceDepth++
      else if (c === '}') {
        braceDepth--
        // 回到模板字面量：只有在 ${ 里才可能发生
        if (tplStack.length && braceDepth === tplStack[tplStack.length - 1]) {
          tplStack.pop()
          state = 'tpl'
          out += c; i++; noteSig(c); continue
        }
      }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'tpl'
      out += c; i++; noteSig(c); continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } i++; continue }
    if (state === 'block') { if (c === '*' && next() === '/') { state = 'code'; i += 2 } else i++; continue }
    if (state === 'html') { if (src.startsWith('-->', i)) { state = 'code'; i += 3 } else i++; continue }
    if (state === 'regex') {
      if (c === '\\') { out += c + next(); i += 2; continue }
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) { state = 'code'; out += c; i++; noteSig(c); continue }
      out += c; i++; continue
    }
    if (state === 'tpl') {
      if (c === '\\') { out += c + next(); i += 2; continue }
      if (c === '`') { state = 'code'; out += c; i++; noteSig(c); continue }
      // 模板里的 ${} 切回代码状态，并记住嵌套层数
      if (c === '$' && next() === '{') { tplStack.push(braceDepth); state = 'code'; out += c; i++; noteSig(c); continue }
      out += c; i++; continue
    }
    // 字符串内：反斜杠转义整体跳过，遇到同类引号收尾
    if (c === '\\') { out += c + next(); i += 2; continue }
    if ((state === 'sq' && c === `'`) || (state === 'dq' && c === '"')) state = 'code'
    out += c; i++
  }
  return out
}

/** 压掉所有空白：注释被剥掉后，代码骨架应逐字符相同 */
const squash = (s) => s.replace(/\s+/g, '')

const walk = (dir, base = dir, acc = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, acc)
    else acc.push(path.relative(base, full).replace(/\\/g, '/'))
  }
  return acc
}

const [, , baselineDir, targetDir] = process.argv
if (!baselineDir || !targetDir) {
  console.error('用法: node scripts/check-comment-only.mjs <基线目录> <当前目录>')
  process.exit(2)
}
for (const dir of [baselineDir, targetDir]) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`目录不存在: ${dir}`)
    process.exit(2)
  }
}

const baseFiles = walk(baselineDir)
const targetFiles = walk(targetDir)
const all = [...new Set([...baseFiles, ...targetFiles])].sort()

let changed = 0
let added = 0
let removed = 0
let same = 0
let addedCommentLines = 0

for (const rel of all) {
  const b = path.join(baselineDir, rel)
  const t = path.join(targetDir, rel)
  if (!existsSync(t)) { console.log(`缺失(新增前不存在,现被删?)  ${rel}`); removed++; continue }
  if (!existsSync(b)) { console.log(`新增文件              ${rel}`); added++; continue }
  const rawB = readFileSync(b, 'utf8')
  const rawT = readFileSync(t, 'utf8')
  addedCommentLines += rawT.split('\n').length - rawB.split('\n').length
  if (squash(strip(rawB)) === squash(strip(rawT))) { same++; continue }
  changed++
  console.log(`代码被改动!  ${rel}`)
  // 定位第一处不同，方便排查
  const sb = squash(strip(rawB))
  const st = squash(strip(rawT))
  let k = 0
  while (k < sb.length && k < st.length && sb[k] === st[k]) k++
  console.log(`   首处差异@${k}: 基线 …${sb.slice(Math.max(0, k - 60), k + 60)}`)
  console.log(`                现在 …${st.slice(Math.max(0, k - 60), k + 60)}`)
}

console.log('─'.repeat(60))
console.log(`一致 ${same} 个 / 代码被改动 ${changed} 个 / 新增 ${added} / 丢失 ${removed}`)
console.log(`注释净增行数 ${addedCommentLines > 0 ? '+' : ''}${addedCommentLines}`)
process.exit(changed === 0 && removed === 0 ? 0 : 1)
