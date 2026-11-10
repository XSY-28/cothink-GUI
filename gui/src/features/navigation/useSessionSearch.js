import { useRef, useState } from "react";

const initialQuery = {query:"",scope:"project",includeArchived:false};

export function useSessionSearch(api, workspaceRef, mounted) {
  const [sessions, setSessions] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [navigationQuery, setNavigationQuery] = useState(initialQuery);
  const [workspaceMatches, setWorkspaceMatches] = useState([]);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const [navigationError, setNavigationError] = useState(null);
  const listQuery = useRef(initialQuery), listRequest = useRef(0), loadedCount = useRef(50);
  const failedRead = useRef(null), explicitRead = useRef(null);

  function seedSessionList(bootstrap) {
    setSessions(bootstrap.sessions);
    setNextCursor(bootstrap.sessionsCursor);
  }

  function querySessions(options = {}) {
    const args = {...options};
    if (Object.hasOwn(args,"workspaceId") && args.workspaceId === undefined) return Promise.resolve({items:[],nextCursor:null});
    if (args.workspaceId === null) args.workspaceId = "";
    if (Object.hasOwn(args,"project") && args.project === null) args.project = "";
    return api.read("sessions",args);
  }

  async function loadSessions({more = false, showProgress = false} = {}) {
    const q = listQuery.current, workspaceId = q.scope === "project" ? workspaceRef.current : undefined;
    // Keep a failed query available for an explicit retry, even when a host refresh arrives.
    if (!showProgress && (explicitRead.current === listRequest.current ||
        (failedRead.current?.query === q && failedRead.current.workspaceId === workspaceId))) return;
    const request = ++listRequest.current;
    const current = () => mounted.current && request === listRequest.current;
    const args = {query:q.query, archived:q.includeArchived ? "all" : "active",
      ...(q.scope === "project" ? {workspaceId} : {}), ...(more && nextCursor ? {cursor:nextCursor} : {})};
    if (showProgress) {
      explicitRead.current = request;
      setNavigationLoading(true);
    }
    try {
      let page = await querySessions(args);
      if (!more) {
        while (current() && page.nextCursor && page.items.length < loadedCount.current) {
          const next = await querySessions({...args,cursor:page.nextCursor});
          page = {...next,items:[...page.items,...next.items]};
        }
      }
      if (!current()) return;
      setSessions(previous => more ? [...new Map([...previous,...page.items].map(s=>[s.id,s])).values()] : page.items);
      setNextCursor(page.nextCursor);
      setWorkspaceMatches(page.workspaceMatches ?? []);
      failedRead.current = null;
      setNavigationError(null);
      if (more) loadedCount.current += page.items.length;
    } catch (error) {
      if (!current()) return;
      if (error.code === "CURSOR_EXPIRED" && more) return loadSessions({showProgress});
      failedRead.current = {query:q,workspaceId,message:error.message,more};
      setNavigationError(failedRead.current);
    } finally {
      if (explicitRead.current === request) explicitRead.current = null;
      if (current()) setNavigationLoading(false);
    }
  }

  function searchSessions(change) {
    loadedCount.current = 50;
    listQuery.current = {...listQuery.current,...change};
    setNavigationQuery(listQuery.current);
    setSessions([]); setWorkspaceMatches([]); setNextCursor(null); setNavigationError(null);
    void loadSessions({showProgress:true});
  }

  const visibleError = navigationError?.query === navigationQuery &&
    navigationError.workspaceId === (navigationQuery.scope === "project" ? workspaceRef.current : undefined) ? navigationError : null;
  return {sessions,nextCursor,navigationQuery,workspaceMatches,navigationLoading,navigationError:visibleError,
    listQuery,listRequest,seedSessionList,querySessions,loadSessions,searchSessions};
}
