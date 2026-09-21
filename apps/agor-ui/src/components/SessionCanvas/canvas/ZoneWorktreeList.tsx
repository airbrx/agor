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
 *  - Click a row → open the worktree in its drawer (`onOpenWorktree`), because a
 *    pinned worktree has no on-canvas card to focus.
 *  - "Remove from zone" hover action → clear `zone_id` (same end state as drag-out).
 *
 * Rows subscribe to their own branch's session slice for the count badge and the
 * latest-status dot, mirroring the existing per-branch subscription BranchNode
 * uses; the list virtualizes so only visible rows mount their subscription.
 */

import type { Session } from '@agor-live/client';
import { isSessionExecuting, SessionStatus } from '@agor-live/client';
import { BranchesOutlined, CloseOutlined, ExportOutlined } from '@ant-design/icons';
import { Badge, Button, Tooltip, Typography, theme } from 'antd';
import React, { useMemo, useState } from 'react';
import { useAgorStore } from '../../../store/agorStore';
import { makeSessionsForBranchSelector, type ZoneMember } from '../../../store/selectors';

/** ~42px per the design; matches the BranchSessionTree row rhythm. */
export const ZONE_WORKTREE_ROW_HEIGHT = 42;

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

interface ZoneWorktreeRowProps {
  member: ZoneMember;
  sourceZoneId: string;
  canEdit: boolean;
  /** Contrasting text color for the zone's background (from getContrastingTextColor).
   *  Row text/icons must use this, not theme tokens, or they vanish on a dark or
   *  strongly-colored zone. Status dot stays semantic (running/failed). */
  textColor: string;
  onOpenWorktree?: (branchId: string) => void;
  onRemoveFromZone?: (member: ZoneMember) => void;
}

const ZoneWorktreeRowComponent: React.FC<ZoneWorktreeRowProps> = ({
  member,
  sourceZoneId,
  canEdit,
  textColor,
  onOpenWorktree,
  onRemoveFromZone,
}) => {
  const { token } = theme.useToken();
  const [hovered, setHovered] = React.useState(false);

  // Per-branch session subscription — the same slice BranchNode subscribes to.
  // A `session:patched` for another branch leaves this array reference untouched,
  // so only the affected row re-renders.
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
      onRemoveFromZone?.(member);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: row contains nested action <button>s; can't use <button> as parent
    <div
      // nodrag/nopan/nowheel: React Flow must not treat pointer events on this
      // row as a node drag, canvas pan, or canvas zoom. Native HTML5 drag is a
      // separate event stream, so the cross-zone drag rides on `draggable`.
      className="nodrag nopan nowheel"
      role="button"
      tabIndex={0}
      draggable={canEdit}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event) => {
        event.stopPropagation();
        onOpenWorktree?.(member.branchId);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenWorktree?.(member.branchId);
        }
      }}
      aria-label={`Open worktree ${member.branch.name}; ${activeSessions.length} sessions; ${statusLabel}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.marginXS,
        height: ZONE_WORKTREE_ROW_HEIGHT,
        padding: `0 ${token.paddingXS}px`,
        borderRadius: token.borderRadiusSM,
        cursor: canEdit ? 'grab' : 'pointer',
        background: hovered ? token.colorFillTertiary : 'transparent',
        boxSizing: 'border-box',
        userSelect: 'none',
      }}
    >
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
        // Contrast against the zone background, not the theme; ellipsis tooltip
        // still shows the full name.
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
          <Tooltip title="Open worktree">
            <Button
              type="text"
              size="small"
              style={{ color: textColor }}
              icon={<ExportOutlined />}
              aria-label={`Open worktree ${member.branch.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenWorktree?.(member.branchId);
              }}
            />
          </Tooltip>
          {canEdit && (
            <Tooltip title="Remove from zone">
              <Button
                type="text"
                size="small"
                style={{ color: textColor }}
                icon={<CloseOutlined />}
                aria-label={`Remove ${member.branch.name} from zone`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveFromZone?.(member);
                }}
              />
            </Tooltip>
          )}
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
  onOpenWorktree?: (branchId: string) => void;
  /** Clear a member's `zone_id` (remove-from-zone and drag-out share this path). */
  onDetachWorktree?: (member: ZoneMember) => void;
}

/** Extra rows rendered above/below the viewport to smooth fast scrolls. */
const OVERSCAN_ROWS = 4;

/**
 * Fixed-height, windowed list of a zone's worktree rows. Because every row is a
 * constant {@link ZONE_WORKTREE_ROW_HEIGHT}, virtualization is a simple offset
 * slice — no extra dependency. A 50+ member zone stays cheap: only the visible
 * (plus overscan) rows mount, so only they subscribe to their branch's sessions.
 * The list scrolls within the zone; the zone does not auto-grow.
 */
export const ZoneWorktreeList: React.FC<ZoneWorktreeListProps> = ({
  members,
  zoneId,
  height,
  canEdit,
  textColor,
  onOpenWorktree,
  onDetachWorktree,
}) => {
  const viewportHeight = Math.max(ZONE_WORKTREE_ROW_HEIGHT, height);
  const [scrollTop, setScrollTop] = useState(0);

  const total = members.length;
  const visibleCount = Math.ceil(viewportHeight / ZONE_WORKTREE_ROW_HEIGHT);
  const startIndex = Math.max(0, Math.floor(scrollTop / ZONE_WORKTREE_ROW_HEIGHT) - OVERSCAN_ROWS);
  const endIndex = Math.min(total, startIndex + visibleCount + OVERSCAN_ROWS * 2);
  const visibleMembers = members.slice(startIndex, endIndex);

  // The zone frame sets pointerEvents:none so cards behind it stay clickable;
  // re-enable pointer + wheel events for the interactive list only. nowheel/
  // nopan/nodrag keep React Flow from panning/zooming/node-dragging on scroll.
  return (
    <div
      className="nodrag nopan nowheel"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onWheelCapture={(event) => {
        // Keep list scroll from bubbling to React Flow's pan/zoom.
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
      {/* Spacer sized to the full list so the scrollbar reflects all rows. */}
      <div style={{ height: total * ZONE_WORKTREE_ROW_HEIGHT, position: 'relative' }}>
        <div style={{ transform: `translateY(${startIndex * ZONE_WORKTREE_ROW_HEIGHT}px)` }}>
          {visibleMembers.map((member) => (
            <ZoneWorktreeRow
              key={member.objectId}
              member={member}
              sourceZoneId={zoneId}
              canEdit={canEdit}
              textColor={textColor}
              onOpenWorktree={onOpenWorktree}
              onRemoveFromZone={onDetachWorktree}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
