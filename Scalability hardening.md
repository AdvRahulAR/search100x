# Implementation Plan — JustEase Scalability Hardening

This plan outlines the changes required to address critical scale blockers (unbounded N+1 message fetching, WebSocket channel bloat, double-submit vulnerabilities, console log pollution, and package redundancies) without impacting existing user workflows.

---

## User Review Required

> [!IMPORTANT]
> - **Lazy Message Loading**: Thread messages will be fetched on demand only when the thread becomes active. The sidebar will display the correct total message count and latest message snippet by leveraging a new Postgres RPC function `fetch_threads_summary`.
> - **Realtime Connection Optimization**: We will collapse the 9 separate WebSocket channels down to a single multiplexed channel.

---

## Open Questions

> [!NOTE]
> There are no open design questions. The changes proposed below preserve all current UI functionality (sidebar snippets, search, message counts) while providing massive performance benefits.

---

## Proposed Changes

### Component 1: Database Migration
*Guided by `justease-supabase-schema`*

#### [NEW] [20260616140000_fetch_threads_summary_rpc.sql](file:///d:/Company%20Codes/Code%20February%20Release%20Version/justease.pro-March/supabase/migrations/20260616140000_fetch_threads_summary_rpc.sql)
Create a new migration file to define a lightweight RPC function that returns thread metadata, message counts, and the latest message snippet in a single optimized query.

---

### Component 2: Interface Definitions
*Guided by `justease-ui-resilience`*

#### [MODIFY] [types.ts](file:///d:/Company%20Codes/Code%20February%20Release%20Version/justease.pro-March/types.ts)
Add optional helper properties to the `Thread` interface:
```typescript
export interface Thread {
  // ... existing fields
  messagesLoaded?: boolean;
  messageCount?: number;
}
```

---

### Component 3: History Service
*Guided by `justease-resilient-services`*

#### [MODIFY] [history.ts](file:///d:/Company%20Codes/Code%20February%20Release%20Version/justease.pro-March/services/history.ts)
*   Update `fetchThreads` to call the `fetch_threads_summary` RPC.
*   Add `fetchMessagesForThread(threadId: string)` to retrieve the full message history for a single thread.

---

### Component 4: App Data Hook
*Guided by `justease-user-dashboard` + `justease-ui-resilience`*

#### [MODIFY] [useAppData.ts](file:///d:/Company%20Codes/Code%20February%20Release%20Version/justease.pro-March/hooks/useAppData.ts)
*   Add a `useEffect` that triggers when `activeThreadId` changes and `messagesLoaded` is false, fetching that thread's messages on-demand and caching them in the local `threads` state.
*   Collapse the 9 separate Realtime channels into **1 combined channel** using chainable `.on()` bindings.
*   Update the Realtime change handler to merge new DB stubs without wiping out loaded message histories in React state.
*   Gate verbose console logs behind `import.meta.env.DEV` check.

---

### Component 5: AI Chat Hook
*Guided by `justease-ui-resilience`*

#### [MODIFY] [useAiChat.ts](file:///d:/Company%20Codes/Code%20February%20Release%20Version/justease.pro-March/hooks/useAiChat.ts)
*   Add an `if (isLoading) return;` block at the start of `handleSubmit` to prevent double-submit.
*   Ensure optimistically created threads default to `messagesLoaded: true`.

---

### Component 6: Package Consolidation
*Guided by `justease-context-understanding`*

#### [MODIFY] [package.json](file:///d:/Company%20Codes/Code%20February%20Release%20Version/justease.pro-March/package.json)
*   *Recommendation for future cleaning*: Standardize icon usages on either `lucide-react` or `@tabler/icons-react` (we currently import both).
*   *Recommendation for future cleaning*: Consolidate PDF generation libraries (currently using both `jspdf` and `pdfmake`).

---

## Verification Plan

### Automated Build Verification
Verify that the React code compiles successfully with no TypeScript errors:
```powershell
npm run build
```

### Manual Verification
1.  **Sidebar Snippet & Counts**: Verify the sidebar correctly shows thread titles, last message snippets, message counts, and timestamps immediately on mount.
2.  **On-Demand Message Fetching**: Select different threads in the sidebar. Verify via the browser Network tab that:
    *   Clicking a thread invokes exactly **one** API request to fetch that thread's messages.
    *   Clicking back and forth between loaded threads does not fetch messages repeatedly (cache hit).
3.  **Realtime Connection Count**: Open the browser console and Network tab, search for WebSocket traffic, and verify that only **one** channel subscription is established instead of nine.
4.  **Double-Submit Guard**: Repeatedly spam click/press Enter on prompt submission; verify only a single generation is spawned.
5.  **Log Cleanliness**: In production builds, verify no structured JSON logs pollute the browser console.
