/**
 * ZoneWorktreeList — renders a zone's pinned worktrees (board-objects whose
 * `zone_id` is this zone) as compact ~42px rows instead of oversized cards.
 *
 * Why this exists: a branch card renders its sessions inline and grows taller
 * than a zone's usable space, so a zone with more than one or two worktrees is
 * unusable. When a worktree is pinned (`zone_id` set) the canvas suppresses its
 * full `branchNode` (see SessionCanvas) and the zone renders it here as a row.
 *
 * Interaction model (all decoupled from React Flow's pointer gestures via native
 * HTML5 drag-and-drop + the `nodrag`/`nopan`/`nowheel` class contract):
 *  - Drag a row onto another zone → that zone's `onDropWorktree` re-parents it
 *    (`board-objects.patch({ zone_id })`). Same-zone drop is a no-op.
 *  - Drag a row out and drop on empty canvas → `dragend` with no successful drop
 *    clears `zone_id` (worktree returns to the canvas as a full card).
 *  - Click a row header → toggle the expanded session list.
 *  - Caret (▶/▼) → explicit expand/collapse toggle.
 *  - "+" button (expanded footer) → open the worktree's full card in a modal.
 *  - "Remove from zone" hover action (X) → confirm, then clear `zone_id` AND
 *    reposition the freed card just below the zone so it lands visibly.
 *
 * Rows subscribe to their own branch's session slice for the count badge and the
 * latest-status dot, mirroring the existing per-branch subscription BranchNode
 * uses; the list virtualizes so only visible rows mount their subscription.
 * Virtualization is disabled when any row is expanded (variable-height rows are
 * uncommon enough that rendering all is cheaper than tracking cumulative offsets).
 */

import type { Session } from '@agor-live/client';
import { isSessionExecuting, SessionStatus } from '@agor-live/client';
import {
  BranchesOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  CloseOutlined,
  ExportOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { Badge, Button, Modal, Tooltip, Typography, theme } from 'antd';
import React, { useMemo, useState } from 'react';
import { useAgorStore } from '../../../store/agorStore';
import { makeSessionsForBranchSelector, type ZoneMember } from '../../../store/selectors';

/** ~42px per the design; matches the BranchSessionTree row rhythm. */
export const ZONE_WORKTREE_ROW_HEIGHT = 42;

/** Height of each session row inside an expanded worktree. */
const SESSION_ROW_HEIGHT = 28;

/** Height of the "Open card" footer button inside an expanded worktree. */
const EXPANDED_FOOTER_HEIGHT = 32;

/** dataTransfer MIME identifying a worktree-row drag; namespaced to avoid clashing with OS drags. */
export const ZONE_WORKTREE_DRAG_MIME = 'application/x-agor-zone-worktree';

/** Payload carried on a worktree-row drag. */
export interface ZoneWorktreeDragPayload {
  branchId: string;
  objectId: string;
  sourceZoneId: string;
}

const EMPTY_SESSIONS: Session[] = Object.freeze([] as Session[]) as Session[];

/** Latest-activity status collapsed to a single dot color, derived from the
 * per-branch session slice already loaded on the client (no new data path). */
type WorktreeStatus = 'running' | 'failed' | 'idle';

function deriveWorktreeStatus(sessions: Session[]): WorktreeStatus {
  let sawFailed = false;
  for (const session of sessions) {
    if (session.archived) continue;
    if (isSessionExecuting(session)) return 'running';
    if (session.status === SessionStatus.FAILED) sawFailed = true;
  }
  return sawFailed ? 'failed' : 'idle';
}

/** Single session row rendered inside an expanded worktree. */
const ZoneSessionRow: React.FC<{
  session: Session;
  textColor: string;
  index: number;
}> = ({ session, textColor, index }) => {
  const { token } = theme.useToken();
  const isRunning = isSessionExecuting(session);
  const statusColor = isRunning
    ? token.colorPrimary
    : session.status === SessionStatus.FAILED
      ? token.colorError
      : token.colorTextQuaternary;

  const label = session.name || `Session ${index + 1}`;
  const statusLabel = isRunning
    ? 'Running'
    : session.status === SessionStatus.FAILED
      ? 'Failed'
      : 'Idle';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.marginXXS,
        height: SESSION_ROW_HEIGHT,
        paddingLeft: token.paddingXL,
        paddingRight: token.paddingXS,
        boxSizing: 'border-box',
      }}
    >
      <Tooltip title={statusLabel}>
        <span
          aria-hidden="true"
          style={{
            flex: '0 0 auto',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: statusColor,
          }}
        />
      </Tooltip>
      <Typography.Text
        ellipsis={{ tooltip: label }}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: token.fontSizeSM - 1,
          color: textColor,
          opacity: 0.75,
        }}
      >
        {label}
      </Typography.Text>
    </div>
  );
};

interface ZoneWorktreeRowProps {
  member: ZoneMember;
  sourceZoneId: string;
  canEdit: boolean;
  isExpanded: boolean;
  /** Contrasting text color for the zone's background (from getContrastingTextColor).
   *  Row text/icons must use this, not theme tokens, or they vanish on a dark or
   *  strongly-colored zone. Status dot stays semantic (running/failed). */
  textColor: string;
  /** Toggle the expanded session list for this worktree. */
  onToggleExpand: (branchId: string) => void;
  /** Open the worktree's full card in a modal (row "+" button / hover "open" button).
   *  This intentionally does NOT open branch settings — the worktree stays
   *  pinned in the zone; the modal just surfaces its full card. */
  onOpenWorktreeCard?: (branchId: string) => void;
  /** Drag-out detach: the gesture already produced a real drop position, so this
   *  path only clears `zone_id` (no confirm, no reposition). */
  onDetachWorktree?: (member: ZoneMember) => void;
  /** X-button detach: a single click with no drop position, so this path
   *  repositions the freed card just below the zone (confirm handled here). */
  onRemoveFromZone?: (member: ZoneMember) => void;
}

const ZoneWorktreeRowComponent: React.FC<ZoneWorktreeRowProps> = ({
  member,
  sourceZoneId,
  canEdit,
  isExpanded,
  textColor,
  onToggleExpand,
  onOpenWorktreeCard,
  onDetachWorktree,
  onRemoveFromZone,
}) => {
  const { token } = theme.useToken();
  const [hovered, setHovered] = React.useState(false);

  // Per-branch session subscription — the same slice BranchNode subscribes to.
  const sessionsSelector = useMemo(
    () => makeSessionsForBranchSelector(member.branchId),
    [member.branchId]
  );
  const sessions = useAgorStore(sessionsSelector) ?? EMPTY_SESSIONS;
  const activeSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions]);
  const status = useMemo(() => deriveWorktreeStatus(sessions), [sessions]);

  const statusColor =
    status === 'running'
      ? token.colorPrimary
      : status === 'failed'
        ? token.colorError
        : token.colorTextQuaternary;
  const statusLabel =
    status === 'running' ? 'Running' : status === 'failed' ? 'Latest task failed' : 'Idle';

  const handleDragStart = (event: React.DragEvent<HTMLElement>) => {
    // Don't start a drag when the pointer is on an action button.
    if ((event.target as HTMLElement).closest('button')) {
      event.preventDefault();
      return;
    }
    if (!canEdit) {
      event.preventDefault();
      return;
    }
    const payload: ZoneWorktreeDragPayload = {
      branchId: member.branchId,
      objectId: member.objectId,
      sourceZoneId,
    };
    event.dataTransfer.setData(ZONE_WORKTREE_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'move';
    event.stopPropagation();
  };

  const handleDragEnd = (event: React.DragEvent<HTMLElement>) => {
    // Drag-out to empty canvas: no zone accepted the drop, so the browser
    // reports dropEffect 'none'. Detach the worktree (zone_id -> null) so it
    // returns to the canvas as a full card. A successful drop on another zone
    // sets dropEffect 'move' and is handled by that zone's onDrop instead.
    if (event.dataTransfer.dropEffect === 'none') {
      onDetachWorktree?.(member);
    }
  };

  return (
    // Outer container: non-draggable wrapper so the expand panel doesn't
    // participate in the drag hit area. Hover state covers the whole row
    // (header + expanded panel) for a cohesive feel.
    <div
      className="nodrag nopan nowheel"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ userSelect: 'none' }}
    >
      {/* ── Header row (42px, draggable) ── */}
      {/* biome-ignore lint/a11y/useSemanticElements: row contains nested action <button>s; can't use <button> as parent */}
      <div
        role="button"
        tabIndex={0}
        draggable={canEdit}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpand(member.branchId);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleExpand(member.branchId);
          }
        }}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} worktree ${member.branch.name}; ${activeSessions.length} sessions; ${statusLabel}`}
        aria-expanded={isExpanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: token.marginXS,
          height: ZONE_WORKTREE_ROW_HEIGHT,
          padding: `0 ${token.paddingXS}px`,
          borderRadius: isExpanded
            ? `${token.borderRadiusSM}px ${token.borderRadiusSM}px 0 0`
            : token.borderRadiusSM,
          cursor: canEdit ? 'grab' : 'pointer',
          background: hovered || isExpanded ? token.colorFillTertiary : 'transparent',
          boxSizing: 'border-box',
        }}
      >
        {/* Caret — explicit expand/collapse; stopPropagation keeps the row
            click from double-firing. */}
        <Button
          type="text"
          size="small"
          className="nodrag"
          style={{ flex: '0 0 auto', color: textColor, opacity: 0.6 }}
          icon={isExpanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
          aria-hidden="true"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpand(member.branchId);
          }}
        />
        <Tooltip title={statusLabel}>
          <span
            aria-hidden="true"
            style={{
              flex: '0 0 auto',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: statusColor,
            }}
          />
        </Tooltip>
        <BranchesOutlined style={{ flex: '0 0 auto', color: textColor, opacity: 0.7 }} />
        <Typography.Text
          ellipsis={{ tooltip: member.branch.name }}
          style={{ flex: 1, minWidth: 0, fontSize: token.fontSizeSM, color: textColor }}
        >
          {member.branch.name}
        </Typography.Text>
        <Badge
          count={activeSessions.length}
          showZero
          style={{ backgroundColor: token.colorPrimaryBgHover, color: token.colorText }}
        />
        {hovered && (
          <div style={{ flex: '0 0 auto', display: 'flex', gap: token.marginXXS }}>
            <Tooltip title="Open card">
              <Button
                type="text"
                size="small"
                className="nodrag"
                style={{ color: textColor }}
                icon={<ExportOutlined />}
                aria-label={`Open card for ${member.branch.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenWorktreeCard?.(member.branchId);
                }}
              />
            </Tooltip>
            {canEdit && (
              <Tooltip title="Remove from zone">
                <Button
                  type="text"
                  size="small"
                  className="nodrag"
                  style={{ color: textColor }}
                  icon={<CloseOutlined />}
                  aria-label={`Remove ${member.branch.name} from zone`}
                  onClick={(event) => {
                    event.stopPropagation();
                    Modal.confirm({
                      title: `Remove ${member.branch.name} from zone?`,
                      content: 'It will return to the board as a card.',
                      okText: 'Remove',
                      onOk: () => onRemoveFromZone?.(member),
                    });
                  }}
                />
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* ── Expanded session list ── */}
      {isExpanded && (
        <div
          className="nodrag nopan nowheel"
          style={{
            background: hovered ? token.colorFillTertiary : token.colorFillQuaternary,
            borderRadius: `0 0 ${token.borderRadiusSM}px ${token.borderRadiusSM}px`,
            paddingBottom: token.paddingXXS,
          }}
        >
          {activeSessions.length === 0 ? (
            <div
              style={{
                height: SESSION_ROW_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                paddingLeft: token.paddingXL,
                paddingRight: token.paddingXS,
              }}
            >
              <Typography.Text
                style={{ fontSize: token.fontSizeSM - 1, color: textColor, opacity: 0.45 }}
              >
                No sessions
              </Typography.Text>
            </div>
          ) : (
            activeSessions.map((session, index) => (
              <ZoneSessionRow
                key={session.session_id}
                session={session}
                textColor={textColor}
                index={index}
              />
            ))
          )}
          {/* "+" footer — opens the full branch card */}
          <div
            style={{
              height: EXPANDED_FOOTER_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              paddingLeft: token.paddingMD,
              paddingRight: token.paddingXS,
              borderTop: `1px solid ${token.colorBorderSecondary}`,
              marginTop: token.marginXXS,
            }}
          >
            <Button
              type="text"
              size="small"
              className="nodrag"
              icon={<PlusOutlined />}
              style={{ color: textColor, opacity: 0.7, fontSize: token.fontSizeSM }}
              onClick={(event) => {
                event.stopPropagation();
                onOpenWorktreeCard?.(member.branchId);
              }}
            >
              <span style={{ fontSize: token.fontSizeSM - 1 }}>Open card</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

const ZoneWorktreeRow = React.memo(ZoneWorktreeRowComponent);

export interface ZoneWorktreeListProps {
  members: ZoneMember[];
  zoneId: string;
  /** Available height (px) for the list body inside the fixed-height zone. */
  height: number;
  canEdit: boolean;
  /** Contrasting text color for the zone background; applied to every row. */
  textColor: string;
  /** Open a member's full card in a modal (row "+" / hover "open" button). */
  onOpenWorktreeCard?: (branchId: string) => void;
  /** Drag-out detach: clear a member's `zone_id`, keeping its stored position. */
  onDetachWorktree?: (member: ZoneMember) => void;
  /** X-button detach: clear `zone_id` AND reposition the freed card below the
   *  zone so it lands visibly instead of behind the zone. */
  onRemoveFromZone?: (member: ZoneMember) => void;
}

/** Extra rows rendered above/below the viewport to smooth fast scrolls. */
const OVERSCAN_ROWS = 4;

/**
 * Fixed-height, windowed list of a zone's worktree rows. Because every row is a
 * constant {@link ZONE_WORKTREE_ROW_HEIGHT} when collapsed, virtualization is a
 * simple offset slice — no extra dependency. When any row is expanded the rows
 * have variable height; we fall back to rendering all rows (zones rarely have
 * enough worktrees for this to matter) and let the scroll container handle it.
 */
export const ZoneWorktreeList: React.FC<ZoneWorktreeListProps> = ({
  members,
  zoneId,
  height,
  canEdit,
  textColor,
  onOpenWorktreeCard,
  onDetachWorktree,
  onRemoveFromZone,
}) => {
  const viewportHeight = Math.max(ZONE_WORKTREE_ROW_HEIGHT, height);
  const [scrollTop, setScrollTop] = useState(0);
  const [expandedBranchId, setExpandedBranchId] = useState<string | null>(null);

  const handleToggleExpand = (branchId: string) => {
    setExpandedBranchId((prev) => (prev === branchId ? null : branchId));
  };

  const hasExpanded = expandedBranchId !== null;
  const total = members.length;

  // When any row is expanded we skip virtualization: variable-height rows make
  // the offset math complex and zones with many worktrees are uncommon.
  let visibleMembers: ZoneMember[];
  let startIndex: number;

  if (hasExpanded) {
    visibleMembers = members;
    startIndex = 0;
  } else {
    const visibleCount = Math.ceil(viewportHeight / ZONE_WORKTREE_ROW_HEIGHT);
    startIndex = Math.max(0, Math.floor(scrollTop / ZONE_WORKTREE_ROW_HEIGHT) - OVERSCAN_ROWS);
    const endIndex = Math.min(total, startIndex + visibleCount + OVERSCAN_ROWS * 2);
    visibleMembers = members.slice(startIndex, endIndex);
  }

  // The zone frame sets pointerEvents:none so cards behind it stay clickable;
  // re-enable pointer + wheel events for the interactive list only.
  return (
    <div
      className="nodrag nopan nowheel"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onWheelCapture={(event) => {
        event.stopPropagation();
      }}
      style={{
        pointerEvents: 'auto',
        flex: 1,
        minHeight: 0,
        width: '100%',
        height: viewportHeight,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {hasExpanded ? (
        // Non-virtualized: render all rows so variable heights are correct.
        <div>
          {visibleMembers.map((member) => (
            <ZoneWorktreeRow
              key={member.objectId}
              member={member}
              sourceZoneId={zoneId}
              canEdit={canEdit}
              isExpanded={member.branchId === expandedBranchId}
              textColor={textColor}
              onToggleExpand={handleToggleExpand}
              onOpenWorktreeCard={onOpenWorktreeCard}
              onDetachWorktree={onDetachWorktree}
              onRemoveFromZone={onRemoveFromZone}
            />
          ))}
        </div>
      ) : (
        // Virtualized: all rows collapsed, constant height.
        <div style={{ height: total * ZONE_WORKTREE_ROW_HEIGHT, position: 'relative' }}>
          <div style={{ transform: `translateY(${startIndex * ZONE_WORKTREE_ROW_HEIGHT}px)` }}>
            {visibleMembers.map((member) => (
              <ZoneWorktreeRow
                key={member.objectId}
                member={member}
                sourceZoneId={zoneId}
                canEdit={canEdit}
                isExpanded={false}
                textColor={textColor}
                onToggleExpand={handleToggleExpand}
                onOpenWorktreeCard={onOpenWorktreeCard}
                onDetachWorktree={onDetachWorktree}
                onRemoveFromZone={onRemoveFromZone}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
