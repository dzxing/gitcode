<script setup lang="ts">
const paths = {
  Archive: 'M3 3h18v5H3Zm2 5v13h14V8m-10 4h6',
  ArchiveRestore: 'M3 3h18v5H3Zm2 5v13h14V8m-7 10v-7m-3 3 3-3 3 3',
  ArrowDown: 'M12 4v16m-6-6 6 6 6-6',
  ArrowUp: 'M12 20V4m-6 6 6-6 6 6',
  ArrowRightLeft: 'M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4',
  ArrowDownToLine: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  ArrowUpFromLine: 'M12 16V3m-5 5 5-5 5 5M4 17v4h16v-4',
  GitBranch:
    'M6 7v10m12-10v3a6 6 0 0 1-6 6H6M9 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0m0 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  GitCommitHorizontal: 'M3 12h4m10 0h4M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  GitMerge:
    'M6 7v10m12 0c0-8-12-2-12-10M9 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0m0 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0m12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  FolderOpen: 'M3 20V5h6l2 3h10v3M3 20l3-9h16l-3 9Z',
  FolderGit2: 'M3 20V5h6l2 3h10v12ZM9 12v5m5-5v2l-5 3',
  ChevronDown: 'm6 9 6 6 6-6',
  ChevronRight: 'm9 6 6 6-6 6',
  ChevronLeft: 'm15 6-6 6 6 6',
  Plus: 'M12 5v14M5 12h14',
  Minus: 'M5 12h14',
  Search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  RefreshCw: 'M20 7a9 9 0 1 0 1 9M20 2v6h-6',
  Settings2: 'M4 6h4m4 0h8M4 18h10m4 0h2M8 3v6m8 6v6M4 12h14',
  Cloud: 'M7 18a5 5 0 1 1 0-10 7 7 0 0 1 13 4 3 3 0 0 1 0 6Z',
  Tag: 'M3 3h8l10 10-8 8L3 11ZM7 7h.01',
  Star: 'm12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91Z',
  X: 'm6 6 12 12M6 18 18 6',
  Check: 'm5 12 4 4L19 6',
  Circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  FileCode2: 'M14 2H4v20h16V8ZM14 2v6h6m-10 4-3 3 3 3m4-6 3 3-3 3',
  FileText: 'M14 2H4v20h16V8ZM14 2v6h6M8 12h8m-8 4h6',
  Copy: 'M8 8h13v13H8ZM16 8V3H3v13h5',
  ExternalLink: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  Keyboard:
    'M2 5h20v14H2Zm4 4h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10',
  Info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6m0-10h.01',
  PanelLeftClose: 'M3 3h18v18H3Zm5 0v18m9-13-4 4 4 4',
  History: 'M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2',
  MoreHorizontal: 'M5 12h.01M12 12h.01M19 12h.01',
  ArrowLeft: 'M20 12H4m6-6-6 6 6 6',
  Command:
    'M8 8h8v8H8ZM8 8H5a3 3 0 1 1 3-3Zm8 0V5a3 3 0 1 1 3 3Zm0 8h3a3 3 0 1 1-3 3Zm-8 0v3a3 3 0 1 1-3-3Z',
  LoaderCircle: 'M21 12a9 9 0 1 1-9-9',
  CheckCheck: 'm2 12 4 4L16 6m-5 10 3 3L24 9',
  CircleHelp: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5m0 3h.01',
  ChevronsUpDown: 'm8 8 4-4 4 4m-8 8 4 4 4-4',
  Sparkles: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z',
  Laptop: 'M4 4h16v12H4ZM2 19h20l-2 2H4Z',
  Monitor: 'M2 3h20v14H2Zm10 14v5m-5 0h10',
  ShieldCheck: 'm12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Zm-5 10 3 3 6-6',
  AlertCircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 6v7m0 4h.01',
}
defineProps<{ name: keyof typeof paths; size?: number }>()
</script>

<template>
  <svg
    :width="size || 16"
    :height="size || 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
