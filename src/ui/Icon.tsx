// Icons: lucide, one stroke weight everywhere.
import type { Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  AlertTriangle, ArrowRight, ArrowUp, BookOpen, Brain, Check, ChevronDown, ChevronRight, Circle, Clock,
  CornerDownRight, Download, ExternalLink, FileDiff, FilePen, FilePlus, FileText, FlaskConical, Folder,
  GitBranch, GitPullRequest, Globe, History, Home, Inbox, Package, KeyRound, LayoutList, Link, MessageSquare,
  Monitor, MoreHorizontal, PanelLeft,
  PanelRight, Pause, Play, Plus, RefreshCw, Route, Search, Settings, Shield,
  Smartphone, Sparkles, Square, SquarePen, SquareTerminal, ArrowLeft, CircleCheck, Terminal, Trash2, Video, Wrench, X, Zap, Puzzle, Bookmark,
  GitMerge, Paperclip, FolderOpen, Copy, Pencil, Lock, LockOpen, Pin, Archive, ArrowUpFromLine, GitCommitHorizontal, Minimize2, Bell, CopyPlus, Slash, AtSign, Columns3, Workflow, Grip, Minus, Maximize, LayoutGrid,
} from "lucide-solid";

const map: Record<string, Component<any>> = {
  alert: AlertTriangle, arrow: ArrowRight, send: ArrowUp, read: BookOpen, brain: Brain, check: Check,
  down: ChevronDown, chevron: ChevronRight, dot: Circle, clock: Clock, handoff: CornerDownRight,
  download: Download, external: ExternalLink, diff: FileDiff, edit: FilePen, write: FilePlus, file: FileText,
  test: FlaskConical, folder: Folder, branch: GitBranch, pr: GitPullRequest, globe: Globe, history: History,
  home: Home, inbox: Inbox, box: Package, key: KeyRound, list: LayoutList, link: Link, board: Columns3, canvas: Workflow, dots: Grip, minus: Minus, fit: Maximize, tidy: LayoutGrid, message: MessageSquare,
  monitor: Monitor, more: MoreHorizontal, panel: PanelRight, panelLeft: PanelLeft, pause: Pause, play: Play, plus: Plus,
  refresh: RefreshCw, route: Route, search: Search, gear: Settings, shield: Shield, phone: Smartphone,
  spark: Sparkles, stop: Square, terminal: SquareTerminal, shell: Terminal, trash: Trash2, video: Video,
  tools: Wrench, x: X, bolt: Zap, skill: Puzzle, memory: Bookmark, compose: SquarePen, back: ArrowLeft,
  done: CircleCheck, merge: GitMerge, clip: Paperclip, open: FolderOpen, copy: Copy, pencil: Pencil, lock: Lock, unlock: LockOpen,
  pin: Pin, archive: Archive, push: ArrowUpFromLine, commit: GitCommitHorizontal, compact: Minimize2, bell: Bell, duplicate: CopyPlus, slash: Slash, at: AtSign,
};

export function Icon(props: { name: string; size?: number; class?: string; stroke?: number }) {
  return (
    <Dynamic
      component={map[props.name] ?? Circle}
      size={props.size ?? 16}
      stroke-width={props.stroke ?? 1.75}
      class={`icon ${props.class ?? ""}`}
      aria-hidden="true"
    />
  );
}
