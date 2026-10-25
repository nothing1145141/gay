<script setup lang="ts">
/** AI 设置弹窗：配置 OpenAI 兼容端点（URL / API Key / 模型 ID）+ 本地像素级引擎。
 *  云端配置存 localStorage，随 AI 请求发给服务端；本地引擎（SAM2 + U²-Net）
 *  就绪后 AI 蒙版默认走本地（免费、图像不出本机），云端作后备。 */
import { computed, ref, watch } from 'vue'
import { NAutoComplete, NButton, NInput, NModal } from 'naive-ui'
import { useEditor, saveAiConfig, aiConfigured, refreshLocalAI } from '@/stores/editor'
import { testAiConfig, downloadLocalModels, localModelsProgress } from '@/api/client'
import type { AiConfig } from '@/api/client'

const store = useEditor()

// 编辑副本：打开时从 store 拷贝，保存时才写回（localStorage）
const draft = ref<AiConfig>({ baseUrl: '', apiKey: '', model: '' })
const models = ref<string[]>([])
const testing = ref(false)
const testMessage = ref('')
const testOk = ref<boolean | null>(null)

// ---- 本地引擎 ----
const local = computed(() => store.localAI)
const localReady = computed(() => !!local.value?.ready)
const downloading = ref(false)
const dlCurrent = ref('')
const dlPercent = ref(0)
const dlError = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPoll(): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null }
}

async function pollProgress(): Promise<void> {
  try {
    const p = await localModelsProgress()
    if (p.total > 0) dlPercent.value = Math.round(p.received / p.total * 100)
    dlCurrent.value = p.current
    dlError.value = p.error
    if (!p.running) {
      stopPoll()
      downloading.value = false
      await refreshLocalAI()
    }
  } catch { /* 轮询失败静默重试 */ }
}

async function onDownload(): Promise<void> {
  if (downloading.value) return
  try {
    await downloadLocalModels()
    downloading.value = true
    dlError.value = ''
    pollTimer = setInterval(() => void pollProgress(), 1000)
  } catch (err) {
    dlError.value = err instanceof Error ? err.message : String(err)
  }
}

watch(() => store.aiSettingsOpen, (open) => {
  if (open) {
    draft.value = { ...store.aiConfig }
    models.value = []
    testMessage.value = ''
    testOk.value = null
    void refreshLocalAI()
  } else {
    stopPoll()
    downloading.value = false
  }
})

const complete = computed(() =>
  !!(draft.value.baseUrl.trim() && draft.value.apiKey.trim() && draft.value.model.trim()))

const modelOptions = computed(() =>
  models.value.map((m) => ({ label: m, value: m })))

async function onTest(): Promise<void> {
  if (testing.value) return
  if (!draft.value.baseUrl.trim() || !draft.value.apiKey.trim()) {
    testOk.value = false
    testMessage.value = '请先填写 URL 与 API Key'
    return
  }
  testing.value = true
  testOk.value = null
  testMessage.value = '连接中…'
  try {
    const r = await testAiConfig(draft.value)
    models.value = r.models
    testOk.value = true
    testMessage.value = r.models.length
      ? `连接成功，共 ${r.models.length} 个模型（模型 ID 可从下拉选择）`
      : '连接成功，但端点未返回模型列表，请手动填写模型 ID'
  } catch (err) {
    testOk.value = false
    testMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    testing.value = false
  }
}

function onSave(): void {
  saveAiConfig(draft.value)
  store.aiSettingsOpen = false
  store.status = aiConfigured() ? 'AI 设置已保存' : 'AI 设置已清空'
}
</script>

<template>
  <NModal :show="store.aiSettingsOpen" @update:show="(v: boolean) => store.aiSettingsOpen = v">
    <div class="ai-settings">
      <h3>AI 设置</h3>
      <p class="desc">
        任意 OpenAI 兼容接口（需视觉模型）。配置仅保存在本机，随请求发给本地服务端；
        使用 AI 功能时图像会上传到该端点。也可用环境变量
        PHOTOLAB_AI_BASE_URL / PHOTOLAB_AI_KEY / PHOTOLAB_AI_MODEL 作为后备。
      </p>

      <label class="field">
        <span class="f-label">URL</span>
        <NInput v-model:value="draft.baseUrl" placeholder="https://api.example.com/v1"
                size="small" @input="() => { models = []; testOk = null; testMessage = '' }" />
      </label>
      <label class="field">
        <span class="f-label">API Key</span>
        <NInput v-model:value="draft.apiKey" type="password" show-password-on="click"
                placeholder="sk-…" size="small" />
      </label>
      <label class="field">
        <span class="f-label">模型 ID</span>
        <NAutoComplete v-model:value="draft.model" :options="modelOptions"
                       placeholder="例如 gpt-4o / qwen-vl-max（可测试后从列表选择）"
                       size="small" blur-input-on-select clearable />
      </label>

      <p class="test-msg" :class="{ ok: testOk === true, bad: testOk === false }">
        {{ testMessage }}
      </p>

      <!-- 本地像素级引擎 -->
      <div class="local-engine">
        <div class="le-title">本地像素级引擎 <span v-if="localReady" class="le-ok">已就绪 · AI 蒙版默认使用</span></div>
        <p class="le-desc">SAM 2 + U²-Net 本地推理：像素级掩码、免费、图像不出本机（CPU 约 2~10 秒/次）。</p>
        <template v-if="local">
          <div v-for="(st, key) in local.models" :key="key" class="le-model">
            <span :class="st.ready ? 'le-dot ok' : 'le-dot'" />
            <span class="le-name">{{ st.file }}</span>
            <span class="le-size">{{ (st.size / 1024 / 1024).toFixed(0) }} MB</span>
          </div>
        </template>
        <p v-if="local && !local.runtime" class="le-warn">
          未安装 onnxruntime：pip install onnxruntime
        </p>
        <div class="le-actions">
          <NButton size="small" :loading="downloading" :disabled="localReady || !local?.runtime"
                   @click="onDownload">
            {{ localReady ? '模型已就绪' : '下载模型（约 575 MB，hf-mirror）' }}
          </NButton>
        </div>
        <div v-if="downloading" class="le-progress">
          <div class="bar"><div class="fill" :style="{ width: dlPercent + '%' }" /></div>
          <span class="pct">{{ dlPercent }}%</span>
          <span class="cur">{{ dlCurrent }}</span>
        </div>
        <p v-if="dlError" class="le-warn">下载失败：{{ dlError }}</p>
      </div>

      <div class="btns">
        <NButton size="small" :loading="testing" @click="onTest">测试连接</NButton>
        <span class="spacer" />
        <NButton size="small" @click="store.aiSettingsOpen = false">取消</NButton>
        <NButton size="small" type="primary" :disabled="!complete" @click="onSave">保存</NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.ai-settings {
  width: min(480px, 92vw);
  background: #1d1d23;
  border: 1px solid #2a2a31;
  border-radius: 8px;
  padding: 16px 18px;
}
h3 { margin: 0 0 6px; font-size: 14px; color: #e8e8ec; }
.desc { margin: 0 0 12px; font-size: 11px; color: #7c7c86; line-height: 1.6; }
.field { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.f-label { width: 56px; flex: none; font-size: 12px; color: #b9b9c0; }
.field :deep(.n-input), .field :deep(.n-auto-complete) { flex: 1; }
.test-msg { min-height: 16px; margin: 2px 0 10px; font-size: 11px; color: #7c7c86; }
.test-msg.ok { color: #4dd07a; }
.test-msg.bad { color: #ff6b6b; }
.local-engine {
  border: 1px dashed #2f3a4d;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
}
.le-title { font-size: 12px; color: #4a9eff; margin-bottom: 4px; }
.le-ok { color: #4dd07a; font-size: 11px; margin-left: 6px; }
.le-desc { margin: 0 0 6px; font-size: 11px; color: #7c7c86; }
.le-model { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #b9b9c0; padding: 1px 0; }
.le-dot { width: 7px; height: 7px; border-radius: 50%; background: #55555e; flex: none; }
.le-dot.ok { background: #4dd07a; }
.le-name { flex: 1; }
.le-size { color: #6d6d76; }
.le-warn { font-size: 11px; color: #e8c268; margin: 4px 0 0; }
.le-actions { margin-top: 6px; }
.le-progress { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.le-progress .bar { flex: 1; height: 6px; border-radius: 3px; background: #2a2a31; overflow: hidden; }
.le-progress .fill { height: 100%; background: #4a9eff; transition: width 0.3s; }
.le-progress .pct { font-size: 11px; color: #e8e8ec; width: 34px; text-align: right; }
.le-progress .cur { font-size: 10px; color: #6d6d76; max-width: 140px; overflow: hidden;
                    text-overflow: ellipsis; white-space: nowrap; }
.btns { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
</style>
