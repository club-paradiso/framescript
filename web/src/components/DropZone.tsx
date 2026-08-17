/**
 * File intake.
 *
 * Both a drop target and a real `<input type="file">`, because drag-and-drop
 * does not exist on a phone and a file picker is the only way in there.
 */

import { useCallback, useRef, useState } from 'react';

const ACCEPT = '.srt,.vtt,.json,.mp4,.m4v,.mov,.webm,.mkv,.mp3,.m4a,.wav,.ogg,.aac,.flac';

export function DropZone({
  onFiles,
  compact = false,
}: {
  onFiles: (files: FileList | File[]) => void;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setOver(false);
      if (event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files);
    },
    [onFiles],
  );

  return (
    <div
      className={`dropzone${over ? ' dropzone--over' : ''}${compact ? ' dropzone--compact' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="visually-hidden"
        id="framescript-file-input"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onFiles(e.target.files);
          // Allow re-selecting the same file after a reset.
          e.target.value = '';
        }}
      />
      <label htmlFor="framescript-file-input" className="dropzone__label">
        <span className="dropzone__primary">{compact ? 'Add files' : 'Choose files'}</span>
        {!compact && (
          <span className="dropzone__secondary">
            or drag them here — subtitles, media, or a FrameScript export
          </span>
        )}
      </label>
    </div>
  );
}
