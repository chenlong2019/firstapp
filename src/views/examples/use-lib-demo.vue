<template>
  <div class="div-bg" ref="viewerRef"></div>
</template>
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { UseLibDemo } from './use-lib-demo'

const viewerRef = ref<HTMLDivElement | null>(null)
let libDemo: UseLibDemo | null = null

onMounted(() => {
  if (viewerRef.value) {
    // 在这里可以使用 viewerRef.value 来访问 div 元素
    libDemo = new UseLibDemo(viewerRef.value!)
    libDemo.init()
  }
})
onUnmounted(() => {
  console.log('组件已卸载')
  libDemo?.destroy()
})
</script>
<style lang="scss" scoped>
.div-bg {
  width: 100%;
  height: 100%;
  position: relative;
}
</style>
