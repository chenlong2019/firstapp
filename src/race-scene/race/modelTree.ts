import * as THREE from 'three'

/**
 * 车辆 GLB 的节点树面板。
 *
 * 模型层级很深(兰博基尼有 500+ 网格、十几层嵌套,关键名字往往挂在父节点而非网格上),
 * 本文件把整棵树与场景联动:点场景里的部件会展开树到它,点树里一行会在场景里高亮同一部件。
 * 行是“展开某一支时才建”而非预先建满——上千个带监听的列表项会让车辆载入时卡顿。
 * 对外导出 `createModelTree`(`ModelTree` / `ModelTreeOptions` 为其入参/句柄类型)。
 */

/**
 * The GLB as a tree, next to the scene.
 *
 * The models in this project are deep: the Lamborghini has more than five hundred
 * meshes under a dozen nested groups, and the names that matter (`DoorLF_CarPaint_66`,
 * `Ext_Door_FL#Car_Paint`) live on the *parents*, not on the mesh. Reading that off
 * a click is one node at a time; this panel is the whole thing at once, and the two
 * views are wired to each other: click a part in the scene and the tree opens to it,
 * click a row and the same part is outlined in the scene.
 *
 * Rows are built when a branch is opened, never up front - a thousand list items
 * with a listener each is a stutter when the car loads, and every one of them is
 * work nobody asked for until somebody scrolls that far.
 */
export type ModelTree = {
  /** Point the tree at a model (a new car, or null while one loads). */
  setRoot(root: THREE.Object3D | null): void
  /** Highlight the row for this object, opening whatever contains it. */
  select(object: THREE.Object3D | null): void
  /** The object whose row is selected, if any. */
  selected(): THREE.Object3D | null
  dispose(): void
}

/** createModelTree 的入参:挂载容器、可选搜索框,以及行点击回调。 */
export type ModelTreeOptions = {
  host: HTMLElement
  search?: HTMLInputElement | null
  /** Called when a row is clicked, never when the selection is set from outside. */
  onSelect?: (object: THREE.Object3D) => void
}

const CHILD_LIMIT = 400

const label = (object: THREE.Object3D) => object.name || '(' + object.type + ')'

/** Vertices of a mesh, or of everything under an object. */
const verticesOf = (object: THREE.Object3D) => {
  let count = 0
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) count += mesh.geometry.getAttribute('position')?.count ?? 0
  })
  return count
}

/** 创建模型树面板,返回 setRoot / select / selected / dispose 句柄。 */
export function createModelTree(options: ModelTreeOptions): ModelTree {
  const { host, search } = options
  const rowOf = new Map<THREE.Object3D, HTMLElement>()
  const open = new Set<THREE.Object3D>()
  const list = document.createElement('div')
  list.className = 'race-tree-list'
  host.append(list)
  let root: THREE.Object3D | null = null
  let current: THREE.Object3D | null = null

  const renderChildren = (object: THREE.Object3D, container: HTMLElement) => {
    container.textContent = ''
    // The scene's own markers (the selection outline) are not part of the model.
    const children = object.children
      .filter((child) => child.userData?.raceHelper !== true)
      .slice(0, CHILD_LIMIT)
    for (const child of children) container.append(renderRow(child))
    if (object.children.length > CHILD_LIMIT) {
      const more = document.createElement('div')
      more.className = 'race-tree-note'
      more.textContent = `…还有 ${object.children.length - CHILD_LIMIT} 个节点`
      container.append(more)
    }
  }

  const renderRow = (object: THREE.Object3D): HTMLElement => {
    // One wrapper per node, holding the row and its branch. `row.after(branch)`
    // cannot be used here: the row is still detached at that point and the
    // insertion is silently dropped, which is how the tree ended up with a
    // single row and nothing under it.
    const wrapper = document.createElement('div')
    wrapper.className = 'race-tree-node'
    const row = document.createElement('div')
    row.className = 'race-tree-row'
    const mesh = object as THREE.Mesh
    if (mesh.isMesh) row.classList.add('is-mesh')
    const hasChildren = object.children.length > 0
    const twisty = document.createElement('button')
    twisty.type = 'button'
    twisty.className = 'race-tree-twisty'
    twisty.textContent = hasChildren ? (open.has(object) ? '▾' : '▸') : '·'
    twisty.disabled = !hasChildren
    twisty.setAttribute('aria-label', hasChildren ? '展开/收起' : '无子节点')
    const name = document.createElement('span')
    name.className = 'race-tree-name'
    name.textContent = label(object)
    name.title = label(object)
    const meta = document.createElement('span')
    meta.className = 'race-tree-meta'
    const visibleChildren = object.children.filter((child) => child.userData?.raceHelper !== true)
    meta.textContent = mesh.isMesh
      ? `Mesh · ${mesh.geometry.getAttribute('position')?.count ?? 0} 顶点`
      : visibleChildren.length
        ? `${visibleChildren.length} 项`
        : object.type
    row.append(twisty, name, meta)
    if (object === current) row.classList.add('is-selected')

    const branch = document.createElement('div')
    branch.className = 'race-tree-branch'
    branch.hidden = !open.has(object)
    wrapper.append(row, branch)
    if (open.has(object)) renderChildren(object, branch)

    twisty.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!hasChildren) return
      if (open.has(object)) open.delete(object)
      else open.add(object)
      twisty.textContent = open.has(object) ? '▾' : '▸'
      branch.hidden = !open.has(object)
      if (open.has(object) && !branch.childElementCount) renderChildren(object, branch)
    })
    row.addEventListener('click', () => {
      setSelection(object)
      options.onSelect?.(object)
    })
    row.dataset.name = label(object)
    rowOf.set(object, row)
    return wrapper
  }

  const setSelection = (object: THREE.Object3D | null) => {
    if (current === object) return
    const previous = current
    current = object
    if (previous) rowOf.get(previous)?.classList.remove('is-selected')
    if (object) rowOf.get(object)?.classList.add('is-selected')
  }

  const renderTree = () => {
    list.textContent = ''
    rowOf.clear()
    if (!root) return
    // The root itself is the model node; its children are the car's top level.
    open.add(root)
    list.append(renderRow(root))
  }

  const matches = (object: THREE.Object3D, query: string) => {
    const text = label(object).toLowerCase()
    return text.includes(query)
  }

  const renderSearch = (query: string) => {
    list.textContent = ''
    rowOf.clear()
    if (!root) return
    const found: THREE.Object3D[] = []
    root.traverse((object) => {
      if (object === root) return
      if (matches(object, query)) found.push(object)
    })
    const note = document.createElement('div')
    note.className = 'race-tree-note'
    note.textContent = found.length ? `匹配 ${found.length} 个节点` : '没有匹配的节点'
    list.append(note)
    for (const object of found.slice(0, 200)) list.append(renderRow(object))
  }

  const onSearchInput = () => {
    const query = (search?.value ?? '').trim().toLowerCase()
    if (query) renderSearch(query)
    else {
      renderTree()
      if (current) select(current)
    }
  }
  search?.addEventListener('input', onSearchInput)

  const select = (object: THREE.Object3D | null) => {
    if (!object || !root) {
      setSelection(null)
      return
    }
    if (search && search.value.trim()) {
      // While filtering, the tree only holds the matches.
      if (rowOf.has(object)) {
        setSelection(object)
        rowOf.get(object)?.scrollIntoView({ block: 'nearest' })
        return
      }
      // Not among them: the filter is in the way of showing what was picked in
      // the scene, so it is dropped and the full tree is built again.
      search.value = ''
      renderTree()
    }
    // Open every ancestor between the root and the object, one level at a time,
    // so the rows exist by the time we ask for the one we want.
    const chain: THREE.Object3D[] = []
    for (let node: THREE.Object3D | null = object; node && node !== root.parent; node = node.parent)
      chain.push(node)
    chain.reverse()
    if (chain[0] !== root) {
      setSelection(null)
      return
    }
    for (const node of chain.slice(0, -1)) {
      if (!node.children.length) continue
      if (!open.has(node)) {
        open.add(node)
        const row = rowOf.get(node)
        const branch = row?.parentElement?.querySelector('.race-tree-branch') as HTMLElement | null
        if (branch) {
          branch.hidden = false
          if (!branch.childElementCount) renderChildren(node, branch)
          const twisty = row?.querySelector('.race-tree-twisty')
          if (twisty) twisty.textContent = '▾'
        }
      }
    }
    setSelection(object)
    rowOf.get(object)?.scrollIntoView({ block: 'nearest' })
  }

  return {
    setRoot(next) {
      root = next
      current = null
      open.clear()
      if (search) search.value = ''
      renderTree()
    },
    select,
    selected: () => current,
    dispose() {
      search?.removeEventListener('input', onSearchInput)
      list.textContent = ''
      rowOf.clear()
      list.remove()
    },
  }
}
