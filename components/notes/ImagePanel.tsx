"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ImagePlus, Trash2, Loader2, ImageOff, Plus, ChevronUp, ChevronDown, Layers, EyeOff } from "lucide-react";
import { MAX_IMAGE_FILE_LABEL } from "@/lib/claude/imageInput";
import { MAX_BUCKET_PARTS, type NoteImage, type NoteImageBucket, type NoteImageFlag } from "@/types";
import type { PasteMode } from "@/hooks/useNotes";

interface Props {
  hasNote:          boolean;
  buckets:          NoteImageBucket[];
  selectedBucketId: string | null;
  uploading:        boolean;
  pasteMode:        PasteMode;
  onSelectBucket:   (id: string) => void;
  onAddBucket:      (file: File) => void;
  onAddPart:        (file: File) => void;
  onRenameBucket:   (id: string, title: string) => void;
  onFlagBucket:     (id: string, flag: NoteImageFlag | null) => void;
  onRemoveBucket:   (id: string) => void;
  onRemovePart:     (id: string) => void;
  onMovePart:       (id: string, direction: -1 | 1) => void;
  onSetPasteMode:   (mode: PasteMode) => void;
  onHide:           () => void;
}

const FLAG_ORDER: NoteImageFlag[] = ["red", "yellow", "green"];
const FLAG_DOT: Record<NoteImageFlag, string> = {
  red:    "bg-red-500",
  yellow: "bg-yellow-400",
  green:  "bg-emerald-500",
};
const FLAG_RING: Record<NoteImageFlag, string> = {
  red:    "ring-red-500",
  yellow: "ring-yellow-400",
  green:  "ring-emerald-500",
};
const FLAG_LABEL: Record<NoteImageFlag, string> = {
  red:    "Red — needs more work",
  yellow: "Yellow — getting there",
  green:  "Green — solid",
};

// Three-way red/yellow/green picker: click a dot to set it, click the active
// one again to clear. Purely a manual signal the learner sets for themselves.
function FlagPicker({ value, onChange }: { value: NoteImageFlag | null; onChange: (v: NoteImageFlag | null) => void }) {
  return (
    <div className="flex items-center gap-1">
      {FLAG_ORDER.map((f) => (
        <button
          key={f}
          type="button"
          title={FLAG_LABEL[f]}
          onClick={() => onChange(value === f ? null : f)}
          className={`h-3.5 w-3.5 rounded-full transition-transform hover:scale-110 ${FLAG_DOT[f]}
            ${value === f ? `ring-2 ring-offset-2 ring-offset-[#0A0F1E] ${FLAG_RING[f]}` : "opacity-40 hover:opacity-80"}`}
        />
      ))}
    </div>
  );
}

// Inline-editable screenshot title: double-click to rename, Enter/blur commits,
// Esc cancels. Kept local — its look differs from the tree's labels.
function EditableTitle({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function commit() {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { setEditing(false); setDraft(value); }
  }

  return editing ? (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
      className="w-56 rounded bg-slate-900 px-1.5 py-0.5 text-sm font-medium text-slate-100 outline-none ring-1 ring-sky-500"
    />
  ) : (
    <span
      onDoubleClick={() => { setDraft(value); setEditing(true); }}
      title="Double-click to rename"
      className="truncate text-sm font-medium text-slate-200"
    >
      {value}
    </span>
  );
}

// Centre pane: the selected screenshot shown large so the learner can read the
// question, with a strip of thumbnails to switch between the note's screenshots.
// Selecting a screenshot here drives the per-screenshot thread in the right pane.
//
// A screenshot is a *bucket*: a question too tall for one capture is stacked
// here as several snips, flush, in order — and goes to the Coach as one
// question. The thumbnail strip shows one tile per bucket, never per snip.
export default function ImagePanel({
  hasNote, buckets, selectedBucketId, uploading, pasteMode,
  onSelectBucket, onAddBucket, onAddPart, onRenameBucket, onFlagBucket,
  onRemoveBucket, onRemovePart, onMovePart, onSetPasteMode, onHide,
}: Props) {
  const newFileRef = useRef<HTMLInputElement>(null);
  const partFileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const selected = buckets.find((b) => b.id === selectedBucketId) ?? buckets[0] ?? null;
  // The bucket's own image is the top slice; its parts stack underneath.
  const slices: NoteImage[] = selected ? [selected, ...selected.parts] : [];
  const full = slices.length >= MAX_BUCKET_PARTS;

  function pickFiles(files: FileList | null, onEach: (f: File) => void) {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (f.type.startsWith("image/")) onEach(f);
    }
  }
  // A drop follows the same rule as a paste: whichever + was used last.
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const target = pasteMode === "current" && selected ? onAddPart : onAddBucket;
    pickFiles(e.dataTransfer.files, target);
  }

  // The pane's hide control. It sits in every branch's header — including the
  // empty states — so this pane can always be collapsed from itself, not only
  // by dragging a divider.
  const hideButton = (
    <button
      type="button"
      onClick={onHide}
      title="Hide screenshots"
      aria-label="Hide screenshots"
      className="shrink-0 rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-sky-400"
    >
      <EyeOff size={15} />
    </button>
  );

  if (!hasNote) {
    return (
      <section className="flex h-full w-full min-w-0 flex-col bg-[#0A0F1E]">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Screenshots</span>
          {hideButton}
        </header>
        <div className="flex min-h-0 flex-1 items-center justify-center text-center">
          <div className="max-w-xs px-6">
            <ImageOff size={28} className="mx-auto mb-3 text-slate-700" />
            <p className="text-sm text-slate-500">
              Pick a note on the left, or create one, to drop in a screenshot.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const hiddenInputs = (
    <>
      <input
        ref={newFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => { pickFiles(e.target.files, onAddBucket); e.target.value = ""; }}
      />
      <input
        ref={partFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => { pickFiles(e.target.files, onAddPart); e.target.value = ""; }}
      />
    </>
  );

  // ── No screenshots yet → dropzone ─────────────────────────────────────────
  if (buckets.length === 0) {
    return (
      <section className="flex h-full w-full min-w-0 flex-col bg-[#0A0F1E]">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Screenshots</span>
          {hideButton}
        </header>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`min-h-0 flex-1 p-4 ${dragOver ? "bg-sky-500/5" : ""}`}
        >
          <button
            type="button"
            onClick={() => newFileRef.current?.click()}
            className={`flex h-full min-h-40 w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center transition-colors
              ${dragOver ? "border-sky-500 text-sky-300" : "border-slate-700 text-slate-500 hover:border-slate-600 hover:text-slate-400"}`}
          >
            <ImagePlus size={26} />
            <span className="text-sm">Drop a screenshot here, paste it, or click to browse</span>
            <span className="text-xs text-slate-600">PNG, JPEG, WebP or GIF · up to {MAX_IMAGE_FILE_LABEL}</span>
          </button>
        </div>
        {hiddenInputs}
      </section>
    );
  }

  // ── Selected screenshot (stacked slices) + thumbnail switcher ─────────────
  return (
    <section
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`flex h-full w-full min-w-0 flex-col bg-[#0A0F1E] ${dragOver ? "bg-sky-500/5" : ""}`}
    >
      {/* Selected screenshot's title + actions */}
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-4 py-2">
        {selected && <EditableTitle value={selected.title} onCommit={(v) => onRenameBucket(selected.id, v)} />}
        {selected && (
          <FlagPicker value={selected.flag} onChange={(f) => onFlagBucket(selected.id, f)} />
        )}

        {/* Where a paste lands. Both + buttons set this; showing it here means
            the learner never has to guess mid-capture. */}
        <button
          type="button"
          onClick={() => onSetPasteMode(pasteMode === "current" ? "new" : "current")}
          title="Click to switch where pasted images go"
          className="ml-auto rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
        >
          Paste → {pasteMode === "current" ? "this screenshot" : "new screenshot"}
        </button>

        <button
          type="button"
          onClick={() => newFileRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
          New
        </button>
        {selected && (
          <button
            type="button"
            onClick={() => onRemoveBucket(selected.id)}
            title="Delete this screenshot and all its snips"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 size={13} /> Delete
          </button>
        )}
        {hideButton}
      </header>

      {/* The stack: slices butt up against each other so a question split across
          two captures reads as one continuous page. */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto w-fit max-w-full overflow-hidden rounded-lg border border-slate-800 shadow-2xl">
          {slices.map((slice, i) => (
            <figure key={slice.id} className="group relative block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={slice.url ?? ""} alt={selected?.title ?? ""} className="block max-w-full" />

              {slices.length > 1 && (
                <>
                  <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-300">
                    {i + 1} / {slices.length}
                  </span>
                  <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <SliceButton
                      title="Move up"
                      disabled={i === 0}
                      onClick={() => onMovePart(slice.id, -1)}
                    >
                      <ChevronUp size={13} />
                    </SliceButton>
                    <SliceButton
                      title="Move down"
                      disabled={i === slices.length - 1}
                      // Nudging the top slice down is the same swap as lifting
                      // the one below it up — the bucket row must stay put.
                      onClick={() => onMovePart(i === 0 ? slices[1].id : slice.id, i === 0 ? -1 : 1)}
                    >
                      <ChevronDown size={13} />
                    </SliceButton>
                    {i > 0 && (
                      <SliceButton title="Remove this snip" onClick={() => onRemovePart(slice.id)} danger>
                        <Trash2 size={13} />
                      </SliceButton>
                    )}
                  </div>
                </>
              )}
            </figure>
          ))}

          {/* The second +: adds another snip to THIS screenshot, for a question
              too tall to capture in one go. */}
          <button
            type="button"
            onClick={() => partFileRef.current?.click()}
            disabled={uploading || full}
            title={full ? `A screenshot can hold ${MAX_BUCKET_PARTS} snips.` : "Add another snip to this screenshot"}
            className="flex w-full items-center justify-center gap-2 border-t border-dashed border-slate-700 bg-slate-900/40 py-2.5 text-xs text-slate-500 transition-colors hover:bg-slate-800/60 hover:text-sky-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-slate-900/40 disabled:hover:text-slate-500"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {full ? `Full — ${MAX_BUCKET_PARTS} snips max` : "Add a snip to this screenshot"}
          </button>
        </div>
      </div>

      {/* Thumbnail strip: one tile per screenshot, badged with its snip count */}
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-t border-slate-800 px-3 py-2.5">
        {buckets.map((bucket) => (
          <button
            key={bucket.id}
            type="button"
            onClick={() => onSelectBucket(bucket.id)}
            title={bucket.title}
            className={`group relative aspect-video h-14 shrink-0 overflow-hidden rounded-md border transition-all
              ${bucket.id === selected?.id ? "border-sky-500 ring-1 ring-sky-500" : "border-slate-800 hover:border-slate-600"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={bucket.url ?? ""} alt={bucket.title} className="h-full w-full object-cover" />
            {bucket.flag && (
              <span
                title={FLAG_LABEL[bucket.flag]}
                className={`absolute left-0.5 top-0.5 h-2 w-2 rounded-full ring-1 ring-black/40 ${FLAG_DOT[bucket.flag]}`}
              />
            )}
            {bucket.parts.length > 0 && (
              <span
                title={`${bucket.parts.length + 1} snips`}
                className="absolute bottom-0.5 right-0.5 flex items-center gap-0.5 rounded bg-black/70 px-1 text-[10px] font-medium text-slate-200"
              >
                <Layers size={9} /> {bucket.parts.length + 1}
              </span>
            )}
            <span
              onClick={(e) => { e.stopPropagation(); onRemoveBucket(bucket.id); }}
              title="Delete screenshot"
              className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-slate-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
            >
              <Trash2 size={11} />
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => newFileRef.current?.click()}
          disabled={uploading}
          title="Start a new screenshot"
          className="flex aspect-video h-14 shrink-0 items-center justify-center rounded-md border border-dashed border-slate-700 text-slate-500 transition-colors hover:border-sky-600 hover:text-sky-400 disabled:opacity-50"
        >
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
        </button>
      </div>

      {hiddenInputs}
    </section>
  );
}

// Small overlay control on a slice — reorder or remove, shown on hover only so
// the screenshot itself stays readable.
function SliceButton({
  title, onClick, disabled, danger, children,
}: {
  title: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded bg-black/70 p-1 text-slate-300 transition-colors disabled:opacity-30
        ${danger ? "hover:text-red-400" : "hover:text-sky-400"}`}
    >
      {children}
    </button>
  );
}
