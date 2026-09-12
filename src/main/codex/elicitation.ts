import type { AgentQuestion } from '@shared/protocol'
import { t } from '../lang'

type Field = { name: string; schema: Record<string, unknown>; values?: Map<string, unknown>; required: boolean; omitLabel?: string }
export interface McpForm {
  questions: AgentQuestion[]
  fields: Field[]
}

/** Standard MCP primitive forms. No defaults are submitted as user consent. */
export function mcpForm(params: Record<string, unknown>): McpForm {
  if (params.mode !== 'form') throw new Error(t('이 MCP 입력 형식은 아직 지원하지 않습니다.', 'This MCP input format is not supported yet.'))
  const schema = params.requestedSchema as Record<string, unknown> | undefined
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined
  if (schema?.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties)) throw new Error('Invalid MCP form schema')
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const fields: Field[] = []
  const questions: AgentQuestion[] = []
  for (const [name, s] of Object.entries(properties)) {
    if (!s || typeof s !== 'object' || !['boolean', 'string', 'number', 'integer'].includes(String(s.type))) throw new Error('Unsupported MCP field: ' + name)
    if (s.type === 'string' && s.format === 'password') throw new Error('MCP forms cannot request passwords')
    const values = new Map<string, unknown>()
    if (s.type === 'boolean') {
      values.set(t('예 · 동의', 'Yes · agree'), true)
      values.set(t('아니요 · 동의하지 않음', 'No · do not agree'), false)
    } else if (Array.isArray(s.enum)) {
      s.enum.forEach((value, i) => values.set(`${i + 1}. ${String(Array.isArray(s.enumNames) ? s.enumNames[i] ?? value : value)}`, value))
    } else if (Array.isArray(s.oneOf)) {
      for (const [i, option] of s.oneOf.entries()) {
        if (!option || typeof option !== 'object' || !('const' in option)) throw new Error('Unsupported MCP choice: ' + name)
        values.set(`${i + 1}. ${String(option.title ?? option.const)}`, option.const)
      }
    }
    const field: Field = { name, schema: s, values: values.size ? values : undefined, required: required.has(name) }
    fields.push(field)
    if (!field.required) {
      field.omitLabel = t('입력 생략', 'Omit this field')
      values.set(field.omitLabel, undefined)
    }
    const title = s.title ?? (Object.keys(properties).length === 1 && s.type === 'boolean' ? '' : name)
    questions.push({
      header: 'MCP · ' + String(params.serverName ?? ''),
      question: [String(params.message ?? ''), String(title), typeof s.description === 'string' ? s.description : ''].filter(Boolean).join('\n\n'),
      multiSelect: false,
      allowCustom: !field.values,
      options: [...values.keys()].map(label => ({ label, description: '' }))
    })
  }
  if (!fields.length) {
    fields.push({ name: '', schema: { type: 'boolean' }, required: true, values: new Map([[t('동의', 'Agree'), true], [t('거절', 'Decline'), false]]) })
    questions.push({ header: 'MCP · ' + String(params.serverName ?? ''), question: String(params.message ?? ''), multiSelect: false, allowCustom: false, options: [...fields[0].values!.keys()].map(label => ({ label, description: '' })) })
  }
  return { questions, fields }
}

export function mcpFormResponse(form: McpForm, answers: string[][] | null): { action: 'accept' | 'cancel' | 'decline'; content: Record<string, unknown> | null } {
  if (!answers) return { action: 'cancel', content: null }
  if (answers.length !== form.fields.length) throw new Error('MCP form is incomplete')
  const content: Record<string, unknown> = {}
  form.fields.forEach((f, i) => {
    const a = answers[i]
    if (!a || a.length !== 1) throw new Error('Missing MCP answer: ' + f.name)
    if (!f.required && a[0] === f.omitLabel) return
    let value: unknown = a[0]
    if (f.values) {
      if (!f.values.has(a[0])) throw new Error('Invalid MCP choice: ' + f.name)
      value = f.values.get(a[0])
    }
    if (value === undefined && !f.required) return
    const s = f.schema
    if (s.type === 'number' || s.type === 'integer') {
      value = typeof value === 'number' ? value : a[0].trim() ? Number(value) : NaN
      if (!Number.isFinite(value) || (s.type === 'integer' && !Number.isInteger(value))) throw new Error('Invalid MCP number: ' + f.name)
      if ((typeof s.minimum === 'number' && Number(value) < s.minimum) || (typeof s.maximum === 'number' && Number(value) > s.maximum)) throw new Error('MCP number is out of range: ' + f.name)
    }
    if (s.type === 'string') {
      if (typeof value !== 'string') throw new Error('Invalid MCP string: ' + f.name)
      if ((typeof s.minLength === 'number' && value.length < s.minLength) || (typeof s.maxLength === 'number' && value.length > s.maxLength)) throw new Error('MCP text length is out of range: ' + f.name)
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) throw new Error('MCP text does not match the requested format: ' + f.name)
    }
    if (f.name) Object.defineProperty(content, f.name, { value, enumerable: true })
    else Object.defineProperty(content, '__empty_form_agreed', { value, enumerable: false })
  })
  if (!form.fields[0].name && content.__empty_form_agreed === false) return { action: 'decline', content: null }
  return { action: 'accept', content }
}
