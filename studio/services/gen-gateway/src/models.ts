// 모델 카탈로그 — 화면(생성 패널)이 폼을 그리는 데 쓰는 정보. 실제 호출 형식은 각 어댑터가 정한다.
// 옵션 값은 2026-09에 확인한 각 서비스 문서 기준이다. 여기 없는 옵션은 params로 그대로 넘길 수 있다.
import type { Capability } from './types.ts'

export interface ModelOption {
  key: string
  label: string
  type: 'enum' | 'number' | 'bool' | 'text'
  values?: (string | number)[]
  default?: string | number | boolean
  min?: number
  max?: number
}

export interface ModelInfo {
  id: string
  label: string
  capability: Capability
  /** 입력 이미지: 없음 · 1장 · 여러 장(방향별) */
  input: 'none' | 'image' | 'images' | 'optional-image'
  /** 프롬프트가 필요한가 */
  prompt: 'required' | 'optional' | 'none'
  note?: string
  options: ModelOption[]
}

const ASPECT = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9']

export const MODELS: ModelInfo[] = [
  {
    id: 'soul',
    label: 'Higgsfield Soul',
    capability: 'image',
    input: 'none',
    prompt: 'required',
    options: [
      { key: 'aspect_ratio', label: '비율', type: 'enum', values: ASPECT, default: '1:1' },
      { key: 'resolution', label: '해상도', type: 'enum', values: ['2K', '4K'], default: '2K' },
      { key: 'num_images', label: '장수', type: 'number', min: 1, max: 4, default: 1 }
    ]
  },
  {
    id: 'seedance-2.0-t2v',
    label: 'Seedance 2.0 · 텍스트→영상',
    capability: 'video',
    input: 'none',
    prompt: 'required',
    options: [
      { key: 'duration', label: '길이(초)', type: 'number', min: 4, max: 15, default: 5 },
      { key: 'resolution', label: '해상도', type: 'enum', values: ['480p', '720p', '1080p'], default: '720p' },
      { key: 'aspect_ratio', label: '비율', type: 'enum', values: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], default: '16:9' },
      { key: 'generate_audio', label: '소리 생성', type: 'bool', default: false }
    ]
  },
  {
    id: 'seedance-2.0-i2v',
    label: 'Seedance 2.0 · 이미지→영상',
    capability: 'video',
    input: 'image',
    prompt: 'optional',
    options: [
      { key: 'duration', label: '길이(초)', type: 'number', min: 4, max: 15, default: 5 },
      { key: 'resolution', label: '해상도', type: 'enum', values: ['480p', '720p', '1080p'], default: '720p' },
      { key: 'generate_audio', label: '소리 생성', type: 'bool', default: false }
    ]
  },
  {
    id: 'kling-2.5-turbo-i2v',
    label: 'Kling 2.5 Turbo Pro · 이미지→영상',
    capability: 'video',
    input: 'image',
    prompt: 'optional',
    options: [
      { key: 'duration', label: '길이(초)', type: 'enum', values: [5, 10], default: 5 },
      { key: 'negative_prompt', label: '네거티브 프롬프트', type: 'text' }
    ]
  },
  {
    id: 'tripo-text-to-3d',
    label: 'Tripo · 텍스트→3D',
    capability: 'model3d',
    input: 'none',
    prompt: 'required',
    options: [
      { key: 'texture', label: '텍스처', type: 'bool', default: true },
      { key: 'texture_quality', label: '텍스처 품질', type: 'enum', values: ['standard', 'detailed'], default: 'standard' },
      { key: 'geometry_quality', label: '형상 품질', type: 'enum', values: ['standard', 'detailed'], default: 'standard' },
      { key: 'quad', label: '쿼드 메시(FBX)', type: 'bool', default: false },
      { key: 'face_limit', label: '면 수 제한', type: 'number', min: 1000, max: 1500000 },
      { key: 'negative_prompt', label: '네거티브 프롬프트', type: 'text' }
    ]
  },
  {
    id: 'tripo-image-to-3d',
    label: 'Tripo · 이미지→3D',
    capability: 'model3d',
    input: 'image',
    prompt: 'none',
    options: [
      { key: 'texture', label: '텍스처', type: 'bool', default: true },
      { key: 'texture_quality', label: '텍스처 품질', type: 'enum', values: ['standard', 'detailed'], default: 'standard' },
      { key: 'geometry_quality', label: '형상 품질', type: 'enum', values: ['standard', 'detailed'], default: 'standard' },
      { key: 'quad', label: '쿼드 메시(FBX)', type: 'bool', default: false }
    ]
  },
  {
    id: 'tripo-multiview-to-3d',
    label: 'Tripo · 여러 방향 이미지→3D',
    capability: 'model3d',
    input: 'images',
    prompt: 'none',
    note: '앞 · 왼쪽 · 뒤 · 오른쪽 순서로 2~4장',
    options: [
      { key: 'texture', label: '텍스처', type: 'bool', default: true },
      { key: 'texture_quality', label: '텍스처 품질', type: 'enum', values: ['standard', 'detailed'], default: 'standard' }
    ]
  },
  {
    id: 'comfy-workflow',
    label: 'ComfyCloud 워크플로',
    capability: 'image',
    input: 'optional-image',
    prompt: 'none',
    note: 'API 형식으로 내보낸 워크플로 JSON 파일. 입력 이미지는 워크플로 안에서 "$INPUT_0"으로 참조',
    options: [{ key: 'workflowPath', label: '워크플로 파일(.json) 경로', type: 'text' }]
  }
]

/** 개발용 가짜 서비스가 켜졌을 때만 */
export const FAKE_MODEL: ModelInfo = { id: 'fake-demo', label: '테스트 모델(과금 없음)', capability: 'image', input: 'optional-image', prompt: 'optional', options: [{ key: 'resolution', label: '해상도', type: 'enum', values: ['1024x1024', '2048x2048'], default: '1024x1024' }] }
