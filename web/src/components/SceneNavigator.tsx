import { formatSceneHeading, formatTimecode, type ReconstructedScene } from '@/core';

export function SceneNavigator({
  scenes,
  language,
  activeSceneId,
  onSelect,
}: {
  scenes: readonly ReconstructedScene[];
  language: string;
  activeSceneId: string | null;
  onSelect: (sceneId: string) => void;
}) {
  return (
    <nav className="scene-nav" aria-label="Scenes">
      <div className="panel-heading">
        <h2>Scenes</h2>
        <span>{scenes.length}</span>
      </div>
      {scenes.length === 0 ? (
        <p className="panel-empty">
          Scenes appear after subtitle reconstruction or media analysis.
        </p>
      ) : (
        <ol>
          {scenes.map((scene, index) => {
            const heading = formatSceneHeading(scene.setting, language) ?? 'Setting not observed';
            const firstDialogue = scene.beats.find((beat) => beat.type === 'dialogue');
            const snippet =
              firstDialogue?.type === 'dialogue'
                ? (firstDialogue.textVariants[language]?.text ??
                  Object.values(firstDialogue.textVariants)[0]?.text)
                : scene.beats[0]?.type === 'action'
                  ? scene.beats[0].description
                  : 'No dialogue';
            return (
              <li key={scene.id}>
                <button
                  type="button"
                  className={activeSceneId === scene.id ? 'is-active' : ''}
                  aria-current={activeSceneId === scene.id ? 'true' : undefined}
                  onClick={() => onSelect(scene.id)}
                >
                  <span className="scene-nav__meta">
                    <b>{String(index + 1).padStart(2, '0')}</b>
                    <time>{formatTimecode(scene.start)}</time>
                    <i className={'status status--' + scene.status}>{scene.status}</i>
                  </span>
                  <strong>{heading}</strong>
                  <span className="scene-nav__snippet">{snippet}</span>
                  <span className="scene-nav__confidence">
                    {scene.provenance.inferred ? 'Inferred' : 'Observed'} ·{' '}
                    {scene.provenance.confidence}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}
