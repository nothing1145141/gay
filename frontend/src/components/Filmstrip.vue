<script setup lang="ts">
/** 底部胶片条：多图缩略图，点击切换（每图独立参数），✕ 从图库移除。 */
import { useEditor, selectImage, removeImage } from '@/stores/editor'
import { thumbUrl } from '@/api/client'

const store = useEditor()
</script>

<template>
  <div v-if="store.library.length" class="filmstrip">
    <div
      v-for="img in store.library"
      :key="img.id"
      class="cell"
      :class="{ current: img.current }"
      :title="`${img.name}（${img.width}×${img.height}）点击切换`"
      @click="selectImage(img.id)"
    >
      <img :src="thumbUrl(img.id, img.serial)" :alt="img.name" draggable="false" />
      <span class="label">{{ img.name }}</span>
      <button class="del" title="从图库移除" @click.stop="removeImage(img.id)">✕</button>
    </div>
  </div>
</template>

<style scoped>
.filmstrip {
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  border-top: 1px solid #232329;
  background: #141419;
  overflow-x: auto;
  overflow-y: hidden;
  flex: none;
}
.cell {
  position: relative;
  flex: none;
  width: 78px;
  height: 58px;
  border: 1px solid #2a2a31;
  border-radius: 4px;
  background: #0d0d10;
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cell:hover { border-color: #55555e; }
.cell.current { border-color: #4a9eff; box-shadow: 0 0 0 1px #4a9eff; }
.cell img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
}
.label {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  font-size: 9px;
  line-height: 14px;
  color: #d8d8de;
  background: rgba(13, 13, 16, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 3px;
  pointer-events: none;
}
.del {
  position: absolute;
  top: 2px; right: 2px;
  width: 16px; height: 16px;
  border: none;
  border-radius: 3px;
  background: rgba(13, 13, 16, 0.72);
  color: #9a9aa4;
  font-size: 10px;
  line-height: 16px;
  padding: 0;
  cursor: pointer;
  opacity: 0;
}
.cell:hover .del { opacity: 1; }
.del:hover { color: #ff6b6b; }
</style>
