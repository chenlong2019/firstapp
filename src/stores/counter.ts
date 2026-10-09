/**
 * Pinia 示例 store(脚手架自带,项目内目前无实际引用,可作组合式 store 的写法参考)。
 *
 * 采用 Pinia 的 setup 风格:在回调内用 ref/computed 定义状态与派生量,末尾 return 出需要
 * 暴露的成员;消费方通过 useCounterStore() 取得实例。
 */
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

/** 计数器 store:count 为源状态,doubleCount 是它的两倍(只读派生),increment 自增 count */
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  const doubleCount = computed(() => count.value * 2)
  function increment() {
    count.value++
  }

  return { count, doubleCount, increment }
})
