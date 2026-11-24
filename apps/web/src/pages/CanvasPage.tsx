import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type IssuePreview } from "../api.ts";
import { Avatar, Markdown, TicketActions, TicketBadge, TicketPicker, WorkerBadge } from "../components/common.tsx";
import { Modal } from "../components/Modal.tsx";
import { StatusRows } from "../components/StatusRows.tsx";
import { TeamLog } from "../components/TeamLog.tsx";
import { isActive, stageLabel, time, tokens } from "../format.ts";
import { actions, latestLog, useApp } from "../store.ts";
import type { StageSpec } from "../types.ts";

const COL = 230;
const ROW = 250;
const X0 = 330;

// ---------------------------------------------------------------- nodes

function TicketInputNode() {
  const repo = useApp((s) => s.settings?.targetRepo);
  const provider = useApp((s) => s.settings?.provider);
  const [mode, setMode] = useState<"write" | "issue">("write");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [issueRef, setIssueRef] = useState("");
  const [preview, setPreview] = useState<IssuePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadIssue = async () => {
    if (!issueRef.trim()) return;
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    try {
      setPreview(await api.previewIssue(issueRef));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "issue" && !preview) return loadIssue();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "issue") {
        await api.createFromIssue(issueRef);
        setIssueRef("");
        setPreview(undefined);
      } else {
        await api.createTicket(title, description);
        setTitle("");
        setDescription("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === "write" ? !!title.trim() : !!preview;

  return (
    <form className="node ticket-node nodrag nowheel" onSubmit={submit} data-testid="ticket-form">
      <h3>🎫 New ticket</h3>
      <div className="seg" role="tablist" aria-label="Ticket source">
        <button type="button" role="tab" aria-selected={mode === "write"} onClick={() => { setMode("write"); setError(undefined); }}>
          Write
        </button>
        <button type="button" role="tab" aria-selected={mode === "issue"} onClick={() => { setMode("issue"); setError(undefined); }}>
          Issue
        </button>
      </div>
      {mode === "write" ? (
        <>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add CSV export to reports" maxLength={200} aria-label="Ticket title" />
          </label>
          <label>
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} placeholder="Paste the ticket details…" aria-label="Ticket description" />
          </label>
        </>
      ) : (
        <>
          <label>
            GitHub issue or Jira key / link
            <div className="row">
              <input
                value={issueRef}
                onChange={(e) => {
                  setIssueRef(e.target.value);
                  setPreview(undefined);
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text").trim();
                  if (text) {
                    e.preventDefault();
                    setIssueRef(text);
                    setPreview(undefined);
                    setTimeout(() => document.getElementById("load-issue")?.click(), 0);
                  }
                }}
                onKeyDown={(e) => {
                  // Send is disabled until a preview exists, so the browser won't submit on Enter: load instead
                  if (e.key === "Enter" && !preview) {
                    e.preventDefault();
                    void loadIssue();
                  }
                }}
                placeholder="#12, owner/repo#12, PROJ-123 or a link"
                aria-label="Issue reference"
              />
              <button type="button" id="load-issue" onClick={loadIssue} disabled={busy || !issueRef.trim()}>
                Load
              </button>
            </div>
          </label>
          {preview && (
            <div className="issue-preview" data-testid="issue-preview">
              <a href={preview.sourceUrl} target="_blank" rel="noreferrer" className="small">
                {preview.sourceRef}
              </a>
              <div className="pr-title">{preview.title}</div>
              <p className="small muted">{preview.description.slice(0, 220)}{preview.description.length > 220 ? "…" : ""}</p>
            </div>
          )}
        </>
      )}
      <div className="small muted target">
        Target: {repo ? <code title={repo}>{repo.split(/[\\/]/).slice(-2).join("/")}</code> : <Link to="/settings">choose a project in Settings</Link>}
        {provider === "demo" && <span className="badge tone-warn">demo mode</span>}
      </div>
      {error && <p className="error-text small">{error}</p>}
      <button type="submit" className="primary" disabled={busy || !ready || !repo}>
        {busy ? (mode === "issue" && !preview ? "Loading…" : "Submitting…") : "Send to the team"}
      </button>
      <Handle type="source" position={Position.Right} id="r" />
    </form>
  );
}

function RoleNode({ data }: NodeProps<Node<{ roleId: string }>>) {
  const role = useApp((s) => s.roles.find((r) => r.id === data.roleId));
  const worker = useApp((s) => s.workers[data.roleId]);
  const ticketId = useApp((s) => s.selectedTicketId);
  const logs = useApp((s) => s.logs);
  const selected = useApp((s) => s.selectedRoleId === data.roleId);
  if (!role) return null;
  const active = worker?.active.find((a) => a.ticketId === ticketId) ?? worker?.active[0];
  const last = latestLog(logs, role.id, ticketId);
  const status = worker?.status ?? "idle";
  return (
    <div className={`node role-node status-${status} ${selected ? "selected" : ""}`} style={{ ["--role" as string]: role.color }} data-testid={`role-node-${role.id}`}>
      <Handle type="target" position={Position.Left} id="l" />
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Top} id="ts" style={{ left: "70%" }} />
      <Handle type="target" position={Position.Bottom} id="bt" style={{ left: "30%" }} />
      <div className="role-head">
        <Avatar role={role} size={28} />
        <div>
          <div className="role-title">{role.title}</div>
          <div className="small muted">{role.name}</div>
        </div>
        <WorkerBadge status={status} />
      </div>
      <div className="role-task small">{active ? active.task : status === "idle" ? "Idle" : status}</div>
      <div className="role-last small muted">{active && last ? last.text : " "}</div>
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="b" />
    </div>
  );
}

function PrNode() {
  const ticketId = useApp((s) => s.selectedTicketId);
  const t = useApp((s) => (ticketId ? s.tickets[ticketId] : undefined));
  const [open, setOpen] = useState<"pr" | "report" | undefined>();
  return (
    <div className="node pr-node" data-testid="pr-node">
      <Handle type="target" position={Position.Left} id="l" />
      <h3>🔀 Pull request</h3>
      {!t && <p className="muted small">The PR for the current ticket appears here.</p>}
      {t && (
        <>
          <div className="pr-title">{t.title}</div>
          {t.sourceRef && (
            <a className="small" href={t.sourceUrl} target="_blank" rel="noreferrer">
              from {t.sourceRef}
            </a>
          )}
          <TicketBadge status={t.status} />
          {t.status === "pr_opened" &&
            (t.repos?.some((r) => r.prUrl)
              ? t.repos
                  .filter((r) => r.prUrl)
                  .map((r) => (
                    <a key={r.name} className="button primary" href={r.prUrl} target="_blank" rel="noreferrer" data-testid="pr-link">
                      Open {r.name} PR ↗
                    </a>
                  ))
              : t.prUrl && (
                  <a className="button primary" href={t.prUrl} target="_blank" rel="noreferrer" data-testid="pr-link">
                    Open PR ↗
                  </a>
                ))}
          {t.prBody && (
            <button onClick={() => setOpen("pr")} data-testid="view-pr">
              View PR description
            </button>
          )}
          {t.report && (
            <button onClick={() => setOpen("report")} data-testid="view-report">
              View report
            </button>
          )}
          {t.status === "paused" && <p className="small">Usage limit reached. Resumes {t.resumeAt ? `at ${time(t.resumeAt)}` : "soon"}.</p>}
          {isActive(t) && <p className="small muted">{t.status === "queued" ? "Waiting in the backlog" : stageLabel(t.stage)}</p>}
          {t.error && <p className="error-text small">{t.error}</p>}
          {t.branch && (
            <p className="small muted">
              Branch <code>{t.branch}</code>
            </p>
          )}
          <p className="small muted">{tokens(t.usage)} tokens</p>
        </>
      )}
      {open && t && (
        <Modal title={open === "pr" ? `PR: ${t.title}` : `Report: ${t.title}`} onClose={() => setOpen(undefined)}>
          <Markdown text={(open === "pr" ? t.prBody : t.report) ?? ""} />
        </Modal>
      )}
    </div>
  );
}

const nodeTypes = { ticket: TicketInputNode, role: RoleNode, pr: PrNode };

// ---------------------------------------------------------------- graph

function buildGraph(stages: StageSpec[], roleIds: string[]) {
  const order: string[] = [];
  for (const s of stages) if (!order.includes(s.role)) order.push(s.role);
  for (const r of roleIds) if (!order.includes(r)) order.push(r);
  const perRow = Math.ceil(order.length / 2);
  const pos = new Map<string, { x: number; y: number; row: number }>();
  order.forEach((r, i) => {
    const row = i < perRow ? 0 : 1;
    const col = row === 0 ? i : i - perRow;
    pos.set(r, { x: X0 + col * COL, y: row * ROW, row });
  });
  const nodes: Node[] = [
    { id: "ticket", type: "ticket", position: { x: 0, y: 10 }, data: {}, draggable: false },
    ...order.map((r) => ({ id: r, type: "role", position: pos.get(r)!, data: { roleId: r } })),
    { id: "pr", type: "pr", position: { x: X0 + perRow * COL + 30, y: 90 }, data: {}, draggable: false },
  ];

  const forward: [string, string, string?][] = [["ticket", stages[0]?.role ?? order[0]!]];
  stages.forEach((s, i) => {
    const next = stages[i + 1];
    forward.push([s.role, next ? next.role : "pr", next?.mode ? `${next.mode} review` : undefined]);
  });
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const [a, b, label] of forward) {
    const k = `${a}->${b}`;
    if (seen.has(k) || a === b) continue;
    seen.add(k);
    const pa = pos.get(a);
    const pb = pos.get(b);
    const crossRow = pa && pb && pa.row !== pb.row;
    edges.push({
      id: `f:${k}`,
      source: a,
      target: b,
      sourceHandle: crossRow ? "b" : "r",
      targetHandle: crossRow ? "t" : "l",
      label,
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { kind: "forward" },
    });
  }
  const loops: [string, string, string][] = [];
  for (const s of stages) {
    if (!s.sendBackTo) continue;
    const to = stages.find((x) => x.id === s.sendBackTo)?.role;
    if (to) loops.push([s.role, to, s.maxSendBacks ? `fix (≤${s.maxSendBacks})` : "fix"]);
  }
  for (const [a, b, label] of loops) {
    const k = `${a}->${b}`;
    if (seen.has(`l:${k}`)) continue;
    seen.add(`l:${k}`);
    const pa = pos.get(a);
    const pb = pos.get(b);
    edges.push({
      id: `l:${k}`,
      source: a,
      target: b,
      sourceHandle: "ts",
      targetHandle: pa && pb && pa.row !== pb.row ? "bt" : "t",
      label,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: "loop-edge",
      data: { kind: "loop" },
    });
  }
  return { nodes, edges };
}

export function CanvasPage() {
  const stages = useApp((s) => s.stages);
  const roles = useApp((s) => s.roles);
  const workers = useApp((s) => s.workers);
  const handoffs = useApp((s) => s.handoffs);
  const ticketId = useApp((s) => s.selectedTicketId);
  const ticket = useApp((s) => (ticketId ? s.tickets[ticketId] : undefined));
  const roleIds = useMemo(() => roles.map((r) => r.id), [roles]);
  const graph = useMemo(() => buildGraph(stages, roleIds), [stages, roleIds]);

  const now = Date.now();
  const edges = graph.edges.map((e) => {
    const targetBusy = workers[e.target]?.active.some((a) => !ticketId || a.ticketId === ticketId);
    const recent = handoffs.some((h) => (!ticketId || h.ticketId === ticketId) && now - h.ts < 4000 && h.from.startsWith(e.source) && h.to.startsWith(e.target));
    const loop = (e.data as { kind: string }).kind === "loop";
    return {
      ...e,
      animated: !loop && !!targetBusy,
      className: [e.className, recent ? "edge-hot" : "", targetBusy && !loop ? "edge-busy" : ""].filter(Boolean).join(" "),
    };
  });

  return (
    <div className="canvas-page">
      <div className="canvas-main">
        <div className="toolbar" data-testid="toolbar">
          <span className="muted">Current ticket</span>
          <TicketPicker />
          <TicketActions />
          <span className="grow" />
          <span className="small muted hint">Click a role to see its output</span>
        </div>
        <div className="flow" data-testid="flow">
          {roles.length > 0 && (
          <ReactFlow
            key={roleIds.join(",")}
            nodes={graph.nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            minZoom={0.3}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => n.type === "role" && actions.selectRole(n.id)}
            nodesConnectable={false}
          >
            <Background gap={24} />
            <Controls showInteractive={false} />
          </ReactFlow>
          )}
        </div>
        <StatusRows />
      </div>
      <TeamLog />
    </div>
  );
}
