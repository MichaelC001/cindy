import type {
  BrowserActRequest,
  BrowserControlRequest,
} from '@cindy/browser-control-runtime';
import type { WebContents } from 'electron';

interface AutomationLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface DebuggerTransport {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

interface AxValue {
  value?: unknown;
}

interface RawAxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface SnapshotRef {
  role: string;
  name?: string;
  value?: string;
  backendDOMNodeId: number;
}

interface SnapshotTreeNode extends SnapshotRef {
  nodeId: string;
  children: number[];
  depth: number;
  ref?: string;
  url?: string;
}

interface ResolvedNode {
  objectId: string;
  backendDOMNodeId?: number;
}

export interface RsbSnapshotResult {
  format: 'ai' | 'aria';
  targetId: string;
  url: string;
  snapshot?: string;
  refs?: Record<string, SnapshotRef>;
  nodes?: Array<{
    ref?: string;
    role: string;
    name?: string;
    value?: string;
    backendDOMNodeId: number;
  }>;
  stats: {
    lines: number;
    chars: number;
    refs: number;
    interactive: number;
  };
}

export interface RsbActResult {
  tabId: string;
  kind: BrowserActRequest['kind'];
  [key: string]: unknown;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

const STRUCTURAL_ROLES = new Set([
  'generic',
  'group',
  'list',
  'none',
  'presentation',
  'rootwebarea',
]);

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_SNAPSHOT_REFS = 2_000;

function axText(value: AxValue | undefined): string {
  const raw = value?.value;
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : String(raw);
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} requires a non-negative finite number`);
  }
  return value;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function escapeSnapshotText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/\s+/g, ' ').trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDebugger(wc: WebContents): DebuggerTransport {
  const candidate = (wc as unknown as { debugger?: DebuggerTransport }).debugger;
  if (!candidate) {
    throw new Error('webContents debugger is unavailable');
  }
  return candidate;
}

async function withDebugger<T>(
  wc: WebContents,
  body: (send: DebuggerTransport['sendCommand']) => Promise<T>,
): Promise<T> {
  const transport = getDebugger(wc);
  const alreadyAttached = transport.isAttached();
  if (!alreadyAttached) {
    transport.attach('1.3');
  }
  try {
    return await body(transport.sendCommand.bind(transport));
  } finally {
    if (!alreadyAttached && transport.isAttached()) {
      transport.detach();
    }
  }
}

function buildSnapshotTree(nodes: RawAxNode[]): { tree: SnapshotTreeNode[]; roots: number[] } {
  const tree: SnapshotTreeNode[] = [];
  const byId = new Map<string, number>();
  for (const raw of nodes) {
    const nodeId = raw.nodeId;
    const backendDOMNodeId = raw.backendDOMNodeId;
    if (
      raw.ignored === true
      || typeof nodeId !== 'string'
      || nodeId === ''
      || typeof backendDOMNodeId !== 'number'
      || backendDOMNodeId <= 0
    ) {
      continue;
    }
    byId.set(nodeId, tree.length);
    tree.push({
      nodeId,
      role: axText(raw.role).toLowerCase() || 'unknown',
      name: axText(raw.name) || undefined,
      value: axText(raw.value) || undefined,
      backendDOMNodeId,
      children: [],
      depth: 0,
    });
  }

  const rawById = new Map(
    nodes
      .filter((node): node is RawAxNode & { nodeId: string } => typeof node.nodeId === 'string')
      .map((node) => [node.nodeId, node]),
  );
  const childIndexes = new Set<number>();
  for (let index = 0; index < tree.length; index += 1) {
    const raw = rawById.get(tree[index].nodeId);
    for (const childId of raw?.childIds ?? []) {
      const childIndex = byId.get(childId);
      if (childIndex === undefined) continue;
      tree[index].children.push(childIndex);
      childIndexes.add(childIndex);
    }
  }

  const roots = tree.map((_node, index) => index).filter((index) => !childIndexes.has(index));
  const stack = (roots.length > 0 ? roots : tree.length > 0 ? [0] : []).map((index) => ({
    index,
    depth: 0,
  }));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const node = tree[current.index];
    node.depth = current.depth;
    for (const child of node.children.toReversed()) {
      stack.push({ index: child, depth: current.depth + 1 });
    }
  }
  return { tree, roots };
}

function shouldReference(node: SnapshotTreeNode): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  return Boolean(node.name) && !STRUCTURAL_ROLES.has(node.role);
}

function shouldRender(
  node: SnapshotTreeNode,
  req: BrowserControlRequest,
): boolean {
  if (typeof req.depth === 'number' && node.depth > req.depth) return false;
  if (req.interactive === true) return INTERACTIVE_ROLES.has(node.role);
  if (req.compact === true && STRUCTURAL_ROLES.has(node.role) && !node.name && !node.ref) {
    return false;
  }
  return true;
}

function renderSnapshotTree(
  tree: SnapshotTreeNode[],
  roots: number[],
  req: BrowserControlRequest,
): string[] {
  const lines: string[] = [];
  const visit = (index: number): void => {
    const node = tree[index];
    if (!node) return;
    if (shouldRender(node, req)) {
      const name = node.name ? ` "${escapeSnapshotText(node.name)}"` : '';
      const ref = node.ref ? ` [ref=${node.ref}]` : '';
      const value = node.value ? ` value="${escapeSnapshotText(node.value)}"` : '';
      const url = node.url ? ` [url=${node.url}]` : '';
      lines.push(`${'  '.repeat(node.depth)}- ${node.role}${name}${ref}${value}${url}`);
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return lines;
}

function truncateSnapshotLines(lines: string[], maxChars: number | undefined): string[] {
  if (maxChars === undefined) return lines;
  if (maxChars <= 0) return [];
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const added = line.length + (out.length > 0 ? 1 : 0);
    if (used + added > maxChars) break;
    out.push(line);
    used += added;
  }
  return out;
}

function visibleRefs(
  refs: Record<string, SnapshotRef>,
  lines: string[],
): Record<string, SnapshotRef> {
  const rendered = lines.join('\n');
  return Object.fromEntries(
    Object.entries(refs).filter(([ref]) => rendered.includes(`[ref=${ref}]`)),
  );
}

async function resolveHref(
  send: DebuggerTransport['sendCommand'],
  backendDOMNodeId: number,
): Promise<string | undefined> {
  const resolved = await send('DOM.resolveNode', { backendNodeId: backendDOMNodeId }) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) return undefined;
  const result = await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function() { return typeof this.href === "string" ? this.href : ""; }',
    returnByValue: true,
  }) as { result?: { value?: unknown } };
  return typeof result.result?.value === 'string' && result.result.value !== ''
    ? result.result.value
    : undefined;
}

async function resolveSelector(
  send: DebuggerTransport['sendCommand'],
  selector: string,
): Promise<ResolvedNode> {
  const evaluated = await send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  }) as { result?: { objectId?: string; subtype?: string } };
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === 'null') {
    throw new Error(`selector not found: ${selector}`);
  }
  const described = await send('DOM.describeNode', { objectId }) as {
    node?: { backendNodeId?: number };
  };
  return { objectId, backendDOMNodeId: described.node?.backendNodeId };
}

async function resolveRef(
  send: DebuggerTransport['sendCommand'],
  target: SnapshotRef,
): Promise<ResolvedNode> {
  const resolved = await send('DOM.resolveNode', {
    backendNodeId: target.backendDOMNodeId,
  }) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error('snapshot ref is stale; take a new snapshot');
  }
  return { objectId, backendDOMNodeId: target.backendDOMNodeId };
}

async function callOnNode<T>(
  send: DebuggerTransport['sendCommand'],
  objectId: string,
  functionDeclaration: string,
  args?: unknown[],
): Promise<T> {
  const result = await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args?.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'page script failed',
    );
  }
  return result.result?.value as T;
}

async function focusNode(
  send: DebuggerTransport['sendCommand'],
  node: ResolvedNode,
  requireEditable = false,
): Promise<void> {
  const result = await callOnNode<{ ok: boolean; reason?: string }>(
    send,
    node.objectId,
    `function(requireEditable) {
      if (!(this instanceof HTMLElement) && !(this instanceof SVGElement)) {
        return { ok: false, reason: "target is not an element" };
      }
      if ("disabled" in this && this.disabled) {
        return { ok: false, reason: "target is disabled" };
      }
      if ("readOnly" in this && this.readOnly) {
        return { ok: false, reason: "target is read-only" };
      }
      if (requireEditable) {
        const textInput = this instanceof HTMLInputElement
          && !["button", "checkbox", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(this.type);
        const editable = textInput
          || this instanceof HTMLTextAreaElement
          || (this instanceof HTMLElement && this.isContentEditable);
        if (!editable) return { ok: false, reason: "target is not editable" };
      }
      this.scrollIntoView({ block: "center", inline: "center" });
      if (typeof this.focus === "function") this.focus();
      return { ok: true };
    }`,
    [requireEditable],
  );
  if (!result?.ok) throw new Error(result?.reason ?? 'unable to focus target');
}

async function centerOfNode(
  send: DebuggerTransport['sendCommand'],
  node: ResolvedNode,
): Promise<{ x: number; y: number }> {
  await focusNode(send, node);
  const box = await send('DOM.getBoxModel', {
    ...(node.backendDOMNodeId
      ? { backendNodeId: node.backendDOMNodeId }
      : { objectId: node.objectId }),
  }) as { model?: { content?: number[]; border?: number[] } };
  const quad = box.model?.content ?? box.model?.border;
  if (!quad || quad.length < 8) throw new Error('target has no visible box');
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function mouseButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === undefined || value === 'left') return 'left';
  if (value === 'right' || value === 'middle') return value;
  throw new Error('button must be left, right, or middle');
}

function modifierMask(modifiers: unknown): number {
  if (!Array.isArray(modifiers)) return 0;
  let mask = 0;
  for (const raw of modifiers) {
    if (typeof raw !== 'string') continue;
    switch (raw.toLowerCase()) {
      case 'alt':
        mask |= 1;
        break;
      case 'control':
      case 'ctrl':
        mask |= 2;
        break;
      case 'meta':
      case 'command':
      case 'cmd':
        mask |= 4;
        break;
      case 'shift':
        mask |= 8;
        break;
    }
  }
  return mask;
}

async function dispatchClick(
  send: DebuggerTransport['sendCommand'],
  x: number,
  y: number,
  request: BrowserActRequest,
): Promise<void> {
  const button = mouseButton(request.button);
  const clickCount = request.doubleClick === true ? 2 : 1;
  const modifiers = modifierMask(request.modifiers);
  for (let count = 1; count <= clickCount; count += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount: count,
      modifiers,
    });
    if (typeof request.delayMs === 'number' && request.delayMs > 0) {
      await delay(Math.min(request.delayMs, 5_000));
    }
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount: count,
      modifiers,
    });
  }
}

function parseKey(raw: string): { key: string; modifiers: number } {
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error('key required');
  return { key, modifiers: modifierMask(parts) };
}

async function dispatchKey(
  send: DebuggerTransport['sendCommand'],
  rawKey: string,
): Promise<void> {
  const { key, modifiers } = parseKey(rawKey);
  const text = key.length === 1 && modifiers === 0 ? key : undefined;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    ...(text ? { text } : {}),
    modifiers,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    modifiers,
  });
}

export class RsbWebviewAutomation {
  private readonly refsByTab = new Map<string, Map<string, SnapshotRef>>();

  constructor(private readonly logger: AutomationLogger) {}

  forgetTab(tabId: string): void {
    this.refsByTab.delete(tabId);
  }

  async snapshot(
    tabId: string,
    wc: WebContents,
    req: BrowserControlRequest,
  ): Promise<RsbSnapshotResult> {
    return withDebugger(wc, async (send) => {
      await send('Accessibility.enable');
      let response: { nodes?: RawAxNode[] };
      if (typeof req.selector === 'string' && req.selector !== '') {
        const selected = await resolveSelector(send, req.selector);
        response = await send('Accessibility.getPartialAXTree', {
          backendNodeId: selected.backendDOMNodeId,
          fetchRelatives: false,
        }) as { nodes?: RawAxNode[] };
      } else {
        response = await send('Accessibility.getFullAXTree') as { nodes?: RawAxNode[] };
      }

      const { tree, roots } = buildSnapshotTree(Array.isArray(response.nodes) ? response.nodes : []);
      const refs: Record<string, SnapshotRef> = {};
      let refNumber = 1;
      for (const node of tree) {
        if (!shouldReference(node) || refNumber > MAX_SNAPSHOT_REFS) continue;
        const ref = `e${refNumber}`;
        refNumber += 1;
        node.ref = ref;
        refs[ref] = {
          role: node.role,
          ...(node.name ? { name: node.name } : {}),
          ...(node.value ? { value: node.value } : {}),
          backendDOMNodeId: node.backendDOMNodeId,
        };
      }

      if (req.urls === true) {
        await Promise.all(
          tree
            .filter((node) => node.role === 'link' && node.ref)
            .map(async (node) => {
              try {
                node.url = await resolveHref(send, node.backendDOMNodeId);
              } catch (err) {
                this.logger.warn('failed to resolve snapshot link URL', { tabId, err });
              }
            }),
        );
      }

      const rawLines = renderSnapshotTree(tree, roots, req);
      const lines = truncateSnapshotLines(rawLines, req.maxChars);
      const visible = visibleRefs(refs, lines);
      this.refsByTab.set(tabId, new Map(Object.entries(visible)));
      const snapshot = lines.join('\n');
      const format = req.snapshotFormat ?? 'ai';
      const stats = {
        lines: lines.length,
        chars: snapshot.length,
        refs: Object.keys(visible).length,
        interactive: Object.values(visible).filter((ref) => INTERACTIVE_ROLES.has(ref.role)).length,
      };
      if (format === 'aria') {
        const limit = positiveInt(req.limit, tree.length || 1, tree.length || 1);
        return {
          format,
          targetId: tabId,
          url: wc.getURL(),
          nodes: tree.slice(0, limit).map((node) => ({
            ...(node.ref && visible[node.ref] ? { ref: node.ref } : {}),
            role: node.role,
            ...(node.name ? { name: node.name } : {}),
            ...(node.value ? { value: node.value } : {}),
            backendDOMNodeId: node.backendDOMNodeId,
          })),
          stats,
        };
      }
      return {
        format,
        targetId: tabId,
        url: wc.getURL(),
        snapshot,
        refs: visible,
        stats,
      };
    });
  }

  async act(
    tabId: string,
    wc: WebContents,
    request: BrowserActRequest,
  ): Promise<RsbActResult> {
    return withDebugger(wc, async (send) => {
      // DOM focus alone is not enough for an embedded <webview>: Chromium's
      // Input domain routes keyboard and mouse events through the currently
      // focused RenderWidgetHost. If Cindy's chat composer still owns the
      // Electron focus, those events land in the composer even though
      // Runtime.callFunctionOn focused an element inside the guest document.
      // Activate the guest before every real input action so CDP dispatches to
      // the WebContents that supplied the snapshot/ref.
      const focusGuest = (): void => {
        wc.focus();
      };
      const resolveTarget = async (
        ref = request.ref,
        selector = request.selector,
      ): Promise<ResolvedNode> => {
        if (typeof selector === 'string' && selector !== '') {
          return resolveSelector(send, selector);
        }
        if (typeof ref !== 'string' || ref === '') {
          throw new Error(`${request.kind} requires ref or selector`);
        }
        const target = this.refsByTab.get(tabId)?.get(ref);
        if (!target) throw new Error(`unknown or stale snapshot ref: ${ref}; take a new snapshot`);
        return resolveRef(send, target);
      };

      switch (request.kind) {
        case 'click': {
          focusGuest();
          const point = await centerOfNode(send, await resolveTarget());
          await dispatchClick(send, point.x, point.y, request);
          return { tabId, kind: request.kind, ...point };
        }
        case 'clickCoords': {
          focusGuest();
          const x = finiteNonNegative(request.x, 'clickCoords.x');
          const y = finiteNonNegative(request.y, 'clickCoords.y');
          await dispatchClick(send, x, y, request);
          return { tabId, kind: request.kind, x, y };
        }
        case 'type':
        case 'fill': {
          focusGuest();
          const target = await resolveTarget();
          await focusNode(send, target, true);
          if (request.kind === 'fill') {
            await callOnNode(
              send,
              target.objectId,
              `function() {
                if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
                  this.value = "";
                  this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
                  return true;
                }
                if (this instanceof HTMLElement && this.isContentEditable) {
                  this.textContent = "";
                  this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
                  return true;
                }
                throw new Error("target is not editable");
              }`,
            );
          }
          if (typeof request.text !== 'string') throw new Error(`${request.kind}.text required`);
          if (request.slowly === true) {
            const perCharacterDelay = Math.min(request.delayMs ?? 50, 1_000);
            for (const character of Array.from(request.text)) {
              await send('Input.insertText', { text: character });
              if (perCharacterDelay > 0) await delay(perCharacterDelay);
            }
          } else {
            await send('Input.insertText', { text: request.text });
          }
          if (request.submit === true) await dispatchKey(send, 'Enter');
          return { tabId, kind: request.kind, textLength: request.text.length };
        }
        case 'press': {
          focusGuest();
          if (request.ref || request.selector) {
            await focusNode(send, await resolveTarget());
          }
          if (typeof request.key !== 'string' || request.key === '') {
            throw new Error('press.key required');
          }
          await dispatchKey(send, request.key);
          return { tabId, kind: request.kind, key: request.key };
        }
        case 'hover': {
          focusGuest();
          const point = await centerOfNode(send, await resolveTarget());
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: point.x,
            y: point.y,
            modifiers: modifierMask(request.modifiers),
          });
          return { tabId, kind: request.kind, ...point };
        }
        case 'drag': {
          focusGuest();
          const start = await centerOfNode(
            send,
            await resolveTarget(request.startRef, undefined),
          );
          const end = await centerOfNode(
            send,
            await resolveTarget(request.endRef, undefined),
          );
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: start.x,
            y: start.y,
            button: 'left',
            clickCount: 1,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: end.x,
            y: end.y,
            button: 'left',
            buttons: 1,
          });
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: end.x,
            y: end.y,
            button: 'left',
            clickCount: 1,
          });
          return { tabId, kind: request.kind, start, end };
        }
        case 'select': {
          const target = await resolveTarget();
          const values = Array.isArray(request.values)
            ? request.values.filter((value): value is string => typeof value === 'string')
            : [];
          if (values.length === 0) throw new Error('select.values required');
          const selected = await callOnNode<string[]>(
            send,
            target.objectId,
            `function(values) {
              if (!(this instanceof HTMLSelectElement)) throw new Error("target is not a select element");
              for (const option of this.options) {
                option.selected = values.includes(option.value) || values.includes(option.label);
              }
              this.dispatchEvent(new Event("input", { bubbles: true }));
              this.dispatchEvent(new Event("change", { bubbles: true }));
              return Array.from(this.selectedOptions, option => option.value);
            }`,
            [values],
          );
          return { tabId, kind: request.kind, values: selected };
        }
        case 'resize': {
          const width = positiveInt(request.width, 0, 16_384);
          const height = positiveInt(request.height, 0, 16_384);
          if (width <= 0 || height <= 0) throw new Error('resize width and height required');
          await send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          return { tabId, kind: request.kind, width, height };
        }
        case 'wait': {
          const timeMs = Math.min(
            typeof request.timeMs === 'number' && request.timeMs >= 0 ? request.timeMs : 0,
            MAX_WAIT_TIMEOUT_MS,
          );
          if (timeMs > 0) await delay(timeMs);
          const timeoutMs = positiveInt(
            request.timeoutMs,
            DEFAULT_WAIT_TIMEOUT_MS,
            MAX_WAIT_TIMEOUT_MS,
          );
          const hasCondition = Boolean(
            request.selector || request.url || request.loadState || request.textGone,
          );
          if (hasCondition) {
            const params = {
              selector: request.selector,
              url: request.url,
              loadState: request.loadState,
              textGone: request.textGone,
              timeoutMs,
            };
            const result = await send('Runtime.evaluate', {
              expression: `(() => {
                const params = ${JSON.stringify(params)};
                const deadline = Date.now() + params.timeoutMs;
                const matches = () => {
                  if (params.selector && !document.querySelector(params.selector)) return false;
                  if (params.url && location.href !== params.url && !location.href.includes(params.url)) return false;
                  if (params.textGone && (document.body?.innerText || "").includes(params.textGone)) return false;
                  if (params.loadState === "load" && document.readyState !== "complete") return false;
                  if (params.loadState === "domcontentloaded" && document.readyState === "loading") return false;
                  if (params.loadState === "networkidle" && document.readyState !== "complete") return false;
                  return true;
                };
                return new Promise((resolve, reject) => {
                  const poll = () => {
                    if (matches()) return resolve({ url: location.href, readyState: document.readyState });
                    if (Date.now() >= deadline) return reject(new Error("wait timed out"));
                    setTimeout(poll, 100);
                  };
                  poll();
                });
              })()`,
              awaitPromise: true,
              returnByValue: true,
              timeout: timeoutMs + 1_000,
            }) as {
              result?: { value?: unknown };
              exceptionDetails?: { exception?: { description?: string }; text?: string };
            };
            if (result.exceptionDetails) {
              throw new Error(
                result.exceptionDetails.exception?.description
                ?? result.exceptionDetails.text
                ?? 'wait failed',
              );
            }
            return { tabId, kind: request.kind, waitedMs: timeMs, state: result.result?.value };
          }
          return { tabId, kind: request.kind, waitedMs: timeMs };
        }
        case 'evaluate':
        case 'close':
          throw new Error(`${request.kind} is handled by the backend`);
      }
    });
  }
}
