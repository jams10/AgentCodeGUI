// 프로젝트 채팅 — 원본 채팅(App)을 아트 프로젝트 폴더에 묶는다.
// 원본 App.tsx에는 연결 지점 1줄(studioChatHooks)만 있고, 목록은 원본과 같은 저장소(getChats)를 읽어 여기서 거른다.
//  - studio:new-chat {dir}  → 새 채팅(또는 빈 채팅 재사용)을 만들고 작업 폴더를 dir로
//  - studio:open-chat {id}  → 그 채팅을 연다
// 엔진(Claude · Codex)은 채팅의 작업 폴더에서 실행되므로, 프로젝트 폴더의 CLAUDE.md · AGENTS.md를 자동으로 읽고
// 생성 MCP 중계기도 그 폴더에서 떠서 게이트웨이가 요청을 그 프로젝트로 분류한다.

export interface ChatBridgeApi {
  newChat: () => void
  setCwd: (dir: string) => void
  openChat: (id: string) => void
}

/** App.tsx의 연결 지점에서 부른다 — 창 이벤트를 원본 함수로 잇는다 */
export function studioChatHooks(api: ChatBridgeApi): () => void {
  const onNew = (e: Event): void => {
    const dir = (e as CustomEvent<{ dir?: string }>).detail?.dir
    api.newChat()
    // 새 채팅은 이전 채팅의 폴더를 물려받으므로 바로 프로젝트 폴더로 바꾼다(빈 채팅을 재사용한 경우도 같다)
    if (dir) api.setCwd(dir)
  }
  const onOpen = (e: Event): void => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id
    if (id) api.openChat(id)
  }
  window.addEventListener('studio:new-chat', onNew)
  window.addEventListener('studio:open-chat', onOpen)
  return () => {
    window.removeEventListener('studio:new-chat', onNew)
    window.removeEventListener('studio:open-chat', onOpen)
  }
}

export const newProjectChat = (dir: string): void => void window.dispatchEvent(new CustomEvent('studio:new-chat', { detail: { dir } }))
export const openChat = (id: string): void => void window.dispatchEvent(new CustomEvent('studio:open-chat', { detail: { id } }))

export interface ProjectChat {
  id: string
  title: string
  updatedAt: number
  active: boolean
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()

/** 이 폴더(와 그 아래)를 작업 폴더로 쓰는 채팅 — 원본 저장소를 읽기만 한다 */
export async function listProjectChats(dir: string): Promise<{ chats: ProjectChat[]; activeInProject: boolean }> {
  const raw = (await window.api.getChats().catch(() => null)) as { chats?: { id: string; title?: string; manualCwd?: string; updatedAt?: number }[]; activeChatId?: string } | null
  const want = norm(dir)
  const inProject = (cwd?: string): boolean => !!cwd && (norm(cwd) === want || norm(cwd).startsWith(want + '\\'))
  const all = raw?.chats ?? []
  const chats = all
    .filter((c) => inProject(c.manualCwd))
    .map((c) => ({ id: c.id, title: c.title || '새 채팅', updatedAt: c.updatedAt ?? 0, active: c.id === raw?.activeChatId }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const active = all.find((c) => c.id === raw?.activeChatId)
  return { chats, activeInProject: inProject(active?.manualCwd) }
}
