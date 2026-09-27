#!/usr/bin/env node
// 생성 게이트웨이 명령줄
//   node studio/services/gen-gateway/src/cli.ts serve               게이트웨이 실행(앱이 띄운다)
//   node studio/services/gen-gateway/src/cli.ts keys list           저장된 키(끝 4자리만)
//   node studio/services/gen-gateway/src/cli.ts keys set <서비스>    키 입력(화면에 표시되지 않음)
//   node studio/services/gen-gateway/src/cli.ts keys remove <서비스>
//   node studio/services/gen-gateway/src/cli.ts balance             서비스별 잔액 확인(생성·과금 없음)
// 서비스: comfy · tripo · higgsfield  (Higgsfield는 "KEY_ID:KEY_SECRET" 형식)
import { boot, paths, runningInfo } from './main.ts'
import { SecretStore } from './secrets.ts'
import type { ProviderId } from './types.ts'

const PROVIDERS: ProviderId[] = ['comfy', 'tripo', 'higgsfield']
const HINT: Record<string, string> = {
  comfy: 'ComfyCloud API 키 (platform.comfy.org → Profile → API Keys, "comfyui-"로 시작)',
  tripo: 'Tripo API 키 (platform.tripo3d.ai → API Keys, "tsk_"로 시작 — Studio 구독과 별개인 API 크레딧 계정)',
  higgsfield: 'Higgsfield API 키 (console.higgsfield.ai → API Keys) — "KEY_ID:KEY_SECRET" 형식으로 한 줄'
}

/** 에코 없이 한 줄 읽기 — 키가 화면·터미널 기록에 남지 않게 */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) return reject(new Error('터미널에서 직접 실행해 주세요(키를 파이프로 넘기지 않아요).'))
    process.stderr.write(prompt)
    let buf = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const done = (err?: Error): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stderr.write('\n')
      err ? reject(err) : resolve(buf)
    }
    const onData = (s: string): void => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') return done(new Error('취소했어요'))
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else if (ch >= ' ') buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

function provider(arg: string | undefined): ProviderId {
  if (!arg || !PROVIDERS.includes(arg as ProviderId)) throw new Error(`서비스 이름을 주세요: ${PROVIDERS.join(' · ')}`)
  return arg as ProviderId
}

async function main(argv: string[]): Promise<void> {
  const [cmd, sub, arg] = argv
  if (cmd === 'serve') {
    if (await runningInfo()) {
      console.error('[gen-gateway] 이미 실행 중이에요.')
      return
    }
    const rt = await boot({ serve: true })
    let stopping = false
    const shutdown = (): void => {
      if (stopping) return
      stopping = true
      // Windows에서 읽던 stdin 핸들이 닫히는 도중 process.exit()을 부르면 libuv가 단언 실패로 죽는다 —
      // 핸들을 먼저 정리하고, 남은 일이 없으면 스스로 끝나게 둔다(안전망으로 unref 타이머).
      process.stdin.removeAllListeners('data')
      process.stdin.pause()
      void rt.stop().finally(() => {
        process.exitCode = 0
        setTimeout(() => process.exit(0), 2000).unref()
      })
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    // 부모(앱)가 표준 입력을 닫으면 함께 종료
    process.stdin.on('end', shutdown)
    process.stdin.on('data', () => {})
    return
  }
  if (cmd === 'keys') {
    const store = new SecretStore(paths().secrets)
    if (sub === 'list') {
      const list = store.list()
      if (!list.length) console.log('저장된 키가 없어요.')
      for (const k of list) console.log(`${k.provider.padEnd(11)} ${k.hint}   ${new Date(k.updatedAt).toLocaleString('ko-KR')}`)
      return
    }
    if (sub === 'set') {
      const p = provider(arg)
      console.error(HINT[p])
      const v = (await readHidden('키 붙여넣기 후 Enter (화면에 표시되지 않아요): ')).trim()
      if (p === 'higgsfield' && !/^[^:\s]+:[^:\s]+$/.test(v)) throw new Error('Higgsfield 키는 "KEY_ID:KEY_SECRET" 형식이어야 해요.')
      await store.set(p, v)
      console.log(`${p} 키를 암호화해 저장했어요 (${store.list().find((k) => k.provider === p)?.hint}). 실행 중인 게이트웨이는 다시 시작해야 반영돼요.`)
      return
    }
    if (sub === 'remove') {
      const p = provider(arg)
      console.log(store.remove(p) ? `${p} 키를 지웠어요.` : `${p} 키가 없어요.`)
      return
    }
  }
  if (cmd === 'balance') {
    const rt = await boot({ serve: false, log: () => {} })
    try {
      const b = await rt.gateway.balances()
      for (const [id, v] of Object.entries(b)) {
        const text = v == null ? (rt.secrets.has(id as ProviderId) ? '조회 API 없음' : '키 없음') : 'error' in v ? `조회 실패 — ${v.error}` : `${v.unit === 'usd' ? '$' + v.amount.toFixed(2) : Math.round(v.amount) + ' 크레딧'}${v.usd != null && v.unit !== 'usd' ? ` (≈ $${v.usd.toFixed(2)})` : ''}`
        console.log(`${id.padEnd(11)} ${text}`)
      }
    } finally {
      await rt.stop()
    }
    return
  }
  console.log(`사용법:
  serve                      게이트웨이 실행
  keys list                  저장된 키 보기(끝 4자리)
  keys set <서비스>          키 저장 — 화면에 표시되지 않아요
  keys remove <서비스>       키 삭제
  balance                    잔액 확인(생성·과금 없음)
서비스: ${PROVIDERS.join(' · ')}`)
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`오류: ${(e as Error).message}`)
  process.exit(1)
})
