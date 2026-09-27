// ComfyCloud 내장 모델 — 워크플로 파일 없이 이름만으로 부르는 파트너 노드 모델.
// 워크플로는 제출할 때마다 params로 새로 만든다(승인 카드에서 옵션을 고쳐도 그대로 반영되도록).
// 노드 입력 이름은 Comfy Cloud /api/object_info에서 확인한 값이다(2026-09).
//  - OpenAIGPTImageNodeV2: prompt · model(동적 콤보: gpt-image-2.5-sunburst | gpt-image-2.5-flare)
//    · model.size · model.custom_width/height(16의 배수, 480~3840) · model.background · model.quality
//    · model.images.image_1 … image_16(참조 이미지, 편집용) · n · seed
import type { GenerationRequest } from '../types.ts'

export const GPT_IMAGE_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] as const
export type GptImageModel = (typeof GPT_IMAGE_MODELS)[number]

export const isComfyPreset = (model: string): model is GptImageModel => (GPT_IMAGE_MODELS as readonly string[]).includes(model)

const SIZES = ['auto', '1024x1024', '1024x1536', '1536x1024', '2048x2048', '2048x1152', '1152x2048', '3840x2160', '2160x3840']
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max']
const BACKGROUNDS = ['auto', 'opaque', 'transparent']
const MAX_REFS = 16

const snap16 = (v: number): number => Math.min(3840, Math.max(480, Math.round(v / 16) * 16))

/**
 * GPT Image 2.5 워크플로. 입력 이미지는 LoadImage("$INPUT_n") 노드로 두고, 제출 때 업로드한 자산으로 바뀐다.
 * width · height를 둘 다 주면 Custom 크기(16의 배수로 맞춤), 아니면 size(기본 auto).
 */
export function gptImageWorkflow(req: GenerationRequest): Record<string, unknown> {
  const p = req.params ?? {}
  const refs = (req.inputs ?? []).filter((i) => i.kind === 'image')
  if (refs.length > MAX_REFS) throw new Error(`참조 이미지는 ${MAX_REFS}장까지예요`)
  if (!req.prompt?.trim()) throw new Error('프롬프트가 필요해요')
  const w = Number(p.width)
  const h = Number(p.height)
  const custom = isFinite(w) && isFinite(h) && w > 0 && h > 0
  const size = custom ? 'Custom' : typeof p.size === 'string' && SIZES.includes(p.size) ? p.size : 'auto'
  const quality = typeof p.quality === 'string' && QUALITIES.includes(p.quality) ? p.quality : 'medium'
  const background = typeof p.background === 'string' && BACKGROUNDS.includes(p.background) ? p.background : 'auto'
  const n = Math.max(1, Math.min(8, Math.round(Number(p.n ?? 1)) || 1))
  const seed = Math.max(0, Math.round(Number(p.seed ?? 0)) || 0)

  const wf: Record<string, unknown> = {}
  const gen: Record<string, unknown> = {
    prompt: req.prompt,
    model: req.model,
    'model.size': size,
    'model.custom_width': custom ? snap16(w) : 1024,
    'model.custom_height': custom ? snap16(h) : 1024,
    'model.background': background,
    'model.quality': quality,
    n,
    seed
  }
  refs.forEach((_, i) => {
    const id = String(10 + i)
    wf[id] = { class_type: 'LoadImage', inputs: { image: `$INPUT_${i}` } }
    gen[`model.images.image_${i + 1}`] = [id, 0]
  })
  wf['1'] = { class_type: 'OpenAIGPTImageNodeV2', inputs: gen }
  wf['2'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'agentstudio', images: ['1', 0] } }
  return wf
}
