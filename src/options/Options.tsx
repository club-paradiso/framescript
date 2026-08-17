/**
 * Settings.
 *
 * The AI and Privacy sections carry the most weight: remote inference is off by
 * default, requires an explicit consent step, and the page states exactly what
 * would leave the device before the toggle can be turned on — computed from the
 * live configuration, not written as static marketing copy.
 */

import { useEffect, useState } from 'react';
import { QUALITY_PREFERENCE_LABELS, type QualityPreferenceId } from '../quality/types';
import { FIDELITY_PROFILES, type AnalysisFidelity } from '../temporal/fidelity';
import { SUPPORTED_SCRIPT_LANGUAGES } from '../screenplay/languageRenderer';
import { describeDataTransmission } from '../settings/types';
import { settingsStore } from '../settings/store';
import { screenplayRepository } from '../storage/repository';
import type { ScreenplaySummary } from '../storage/schema';
import { useAppearance, useSettings } from '../ui/hooks';

type SectionId =
  | 'playback'
  | 'analysis'
  | 'languages'
  | 'screenplay'
  | 'ai'
  | 'storage'
  | 'privacy'
  | 'appearance'
  | 'advanced';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'playback', label: 'Playback' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'languages', label: 'Languages' },
  { id: 'screenplay', label: 'Screenplay' },
  { id: 'ai', label: 'AI' },
  { id: 'storage', label: 'Storage' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'advanced', label: 'Advanced' },
];

export function Options() {
  const { settings, update, loaded } = useSettings();
  const [section, setSection] = useState<SectionId>('playback');
  useAppearance(settings);

  if (!loaded) return <div className="fs-options"><p className="fs-muted">Loading…</p></div>;

  return (
    <div className="fs-options">
      <header className="fs-options__header">
        <span className="fs-wordmark">FRAMESCRIPT</span>
        <h1>Settings</h1>
        <p className="fs-secondary">Watch at the best quality. Understand it like a screenplay.</p>
      </header>

      <div className="fs-options__body">
        <nav className="fs-options__nav" aria-label="Settings sections">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              className={`fs-options__nav-item${section === entry.id ? ' fs-options__nav-item--active' : ''}`}
              onClick={() => setSection(entry.id)}
              aria-current={section === entry.id ? 'page' : undefined}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <main className="fs-options__content">
          {section === 'playback' && <PlaybackSection settings={settings} update={update} />}
          {section === 'analysis' && <AnalysisSection settings={settings} update={update} />}
          {section === 'languages' && <LanguageSection settings={settings} update={update} />}
          {section === 'screenplay' && <ScreenplaySection settings={settings} update={update} />}
          {section === 'ai' && <AiSection settings={settings} update={update} />}
          {section === 'storage' && <StorageSection />}
          {section === 'privacy' && <PrivacySection settings={settings} update={update} />}
          {section === 'appearance' && <AppearanceSection settings={settings} update={update} />}
          {section === 'advanced' && <AdvancedSection settings={settings} update={update} />}
        </main>
      </div>
    </div>
  );
}

type SectionProps = {
  settings: ReturnType<typeof useSettings>['settings'];
  update: ReturnType<typeof useSettings>['update'];
};

function PlaybackSection({ settings, update }: SectionProps) {
  return (
    <Section title="Playback" description="FrameScript selects the best quality the platform currently offers. It never unlocks a quality your account or the video does not provide.">
      <Toggle
        label="Maximum quality"
        description="Automatically select the highest available quality."
        checked={settings.playback.maximumQualityEnabled}
        onChange={(v) => void update({ playback: { maximumQualityEnabled: v } })}
      />

      <Field label="YouTube quality" htmlFor="yt-quality">
        <select
          id="yt-quality"
          className="fs-select"
          value={settings.playback.youtubeQuality}
          onChange={(e) =>
            void update({ playback: { youtubeQuality: e.target.value as QualityPreferenceId } })
          }
        >
          {Object.entries(QUALITY_PREFERENCE_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Toggle
        label="Prefer enhanced bitrate when available"
        description="Use YouTube's higher-bitrate variant when your account is entitled to it. FrameScript never bypasses entitlement."
        checked={settings.playback.preferEnhancedBitrate}
        onChange={(v) => void update({ playback: { preferEnhancedBitrate: v } })}
      />

      <Toggle
        label="Respect manual quality override"
        description="If you change quality yourself, FrameScript leaves that video alone and resumes on the next one."
        checked={settings.playback.respectManualOverride}
        onChange={(v) => void update({ playback: { respectManualOverride: v } })}
      />

      <Toggle
        label="Netflix quality guard"
        description="Report what this environment supports and what Netflix is actually delivering. FrameScript does not and cannot change Netflix's quality."
        checked={settings.playback.netflixQualityGuard}
        onChange={(v) => void update({ playback: { netflixQualityGuard: v } })}
      />
    </Section>
  );
}

function AnalysisSection({ settings, update }: SectionProps) {
  return (
    <Section title="Analysis" description="How densely FrameScript observes the picture, and which evidence sources it uses.">
      <Field label="Analysis fidelity">
        <div className="fs-fidelity">
          {(Object.keys(FIDELITY_PROFILES) as AnalysisFidelity[]).map((id) => {
            const profile = FIDELITY_PROFILES[id];
            return (
              <label
                key={id}
                className={`fs-fidelity__option${settings.analysis.fidelity === id ? ' fs-fidelity__option--active' : ''}`}
              >
                <input
                  type="radio"
                  name="fidelity"
                  checked={settings.analysis.fidelity === id}
                  onChange={() => void update({ analysis: { fidelity: id } })}
                />
                <span className="fs-fidelity__body">
                  <span className="fs-fidelity__label">
                    {profile.label}
                    {id === 'detailed' && <span className="fs-tag">Recommended</span>}
                  </span>
                  <span className="fs-muted">{profile.description}</span>
                  <span className="fs-muted fs-mono">
                    {profile.temporalIntervalMs === 0
                      ? 'presented frames'
                      : `${profile.temporalIntervalMs} ms observation`}
                    {' · '}
                    {profile.baselineDeepFps}–{profile.peakDeepFps} deep analyses/s
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </Field>

      <Field label="Evidence sources">
        <p className="fs-muted fs-field__hint">
          Turning a source off makes the screenplay thinner. Subtitles carry dialogue; the picture carries
          action; audio carries speakers, sound and timing.
        </p>
        <Toggle
          label="Subtitles"
          checked={settings.analysis.sources.subtitles}
          onChange={(v) => void update({ analysis: { sources: { subtitles: v } } })}
        />
        <Toggle
          label="Audio"
          checked={settings.analysis.sources.audio}
          onChange={(v) => void update({ analysis: { sources: { audio: v } } })}
        />
        <Toggle
          label="Video"
          checked={settings.analysis.sources.video}
          onChange={(v) => void update({ analysis: { sources: { video: v } } })}
        />
        <Toggle
          label="On-screen text"
          checked={settings.analysis.sources.ocr}
          onChange={(v) => void update({ analysis: { sources: { ocr: v } } })}
        />
        <Toggle
          label="Sound events"
          checked={settings.analysis.sources.soundEvents}
          onChange={(v) => void update({ analysis: { sources: { soundEvents: v } } })}
        />
      </Field>
    </Section>
  );
}

function LanguageSection({ settings, update }: SectionProps) {
  return (
    <Section
      title="Languages"
      description="Scene understanding is shared across languages. Each screenplay language is a rendering of the same analysis, not a separate pass."
    >
      <Field label="Script language" htmlFor="script-language">
        <select
          id="script-language"
          className="fs-select"
          value={settings.languages.scriptLanguage}
          onChange={(e) => void update({ languages: { scriptLanguage: e.target.value } })}
        >
          <option value="system">Follow the browser</option>
          {SUPPORTED_SCRIPT_LANGUAGES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </Field>

      <Toggle
        label="Show original dialogue"
        description="Prefer the platform's own subtitle text over any translation."
        checked={settings.languages.showOriginalDialogue}
        onChange={(v) => void update({ languages: { showOriginalDialogue: v } })}
      />

      <Toggle
        label="Dual-language view"
        description="Show two languages side by side, aligned by time rather than by cue index."
        checked={settings.languages.dualLanguageView}
        onChange={(v) => void update({ languages: { dualLanguageView: v } })}
      />

      {settings.languages.dualLanguageView && (
        <Field label="Second language" htmlFor="secondary-language">
          <select
            id="secondary-language"
            className="fs-select"
            value={settings.languages.secondaryLanguage}
            onChange={(e) => void update({ languages: { secondaryLanguage: e.target.value } })}
          >
            {SUPPORTED_SCRIPT_LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Note>
        FrameScript captures whichever subtitle track you select in the player, and keeps every track it has
        seen. Switching the player's subtitle language adds a track; it never discards one.
      </Note>
    </Section>
  );
}

function ScreenplaySection({ settings, update }: SectionProps) {
  return (
    <Section title="Screenplay" description="How the reconstructed screenplay is displayed.">
      <Field label="Default view" htmlFor="default-view">
        <select
          id="default-view"
          className="fs-select"
          value={settings.screenplay.defaultView}
          onChange={(e) =>
            void update({
              screenplay: { defaultView: e.target.value as 'dialogue' | 'screenplay' | 'evidence' },
            })
          }
        >
          <option value="screenplay">Screenplay</option>
          <option value="dialogue">Dialogue</option>
          <option value="evidence">Evidence</option>
        </select>
      </Field>

      <Toggle
        label="Show timestamps"
        checked={settings.screenplay.showTimestamps}
        onChange={(v) => void update({ screenplay: { showTimestamps: v } })}
      />
      <Toggle
        label="Follow playback"
        checked={settings.screenplay.followPlayback}
        onChange={(v) => void update({ screenplay: { followPlayback: v } })}
      />
      <Toggle
        label="Auto scroll"
        checked={settings.screenplay.autoScroll}
        onChange={(v) => void update({ screenplay: { autoScroll: v } })}
      />
      <Toggle
        label="Include low-confidence beats"
        description="Show elements supported only by weak inference. Off by default: a thinner screenplay is better than a confidently wrong one."
        checked={settings.screenplay.includeLowConfidence}
        onChange={(v) => void update({ screenplay: { includeLowConfidence: v } })}
      />
    </Section>
  );
}

function AiSection({ settings, update }: SectionProps) {
  const transmission = describeDataTransmission(settings);
  const canEnable = settings.ai.consentAcknowledged;

  return (
    <Section
      title="AI"
      description="FrameScript runs locally by default. Deep scene understanding — describing what is happening in the picture — needs a capable model, which means your own API key and your explicit consent."
    >
      <div className="fs-consent">
        <h3>What would leave this device</h3>
        <ul>
          {transmission.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <Toggle
        label="I understand what is transmitted"
        description="Required before remote AI can be enabled."
        checked={settings.ai.consentAcknowledged}
        onChange={(v) =>
          void update({ ai: { consentAcknowledged: v, ...(v ? {} : { remoteEnabled: false }) } })
        }
      />

      <Toggle
        label="Enable remote AI"
        description={canEnable ? undefined : 'Acknowledge the notice above first.'}
        checked={settings.ai.remoteEnabled}
        disabled={!canEnable}
        onChange={(v) => void update({ ai: { remoteEnabled: v } })}
      />

      <fieldset className="fs-subsection" disabled={!settings.ai.remoteEnabled}>
        <legend>Vision — scene understanding</legend>
        <Field label="Provider" htmlFor="vision-provider">
          <select
            id="vision-provider"
            className="fs-select"
            value={settings.ai.vision.provider}
            onChange={(e) =>
              void update({ ai: { vision: { provider: e.target.value as 'none' | 'anthropic' } } })
            }
          >
            <option value="none">None (local motion analysis only)</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </Field>
        <Field label="Model" htmlFor="vision-model">
          <input
            id="vision-model"
            className="fs-input"
            value={settings.ai.vision.model}
            onChange={(e) => void update({ ai: { vision: { model: e.target.value } } })}
            placeholder="claude-sonnet-5"
          />
        </Field>
        <Field label="API key" htmlFor="vision-key">
          <input
            id="vision-key"
            className="fs-input"
            type="password"
            value={settings.ai.vision.apiKey}
            onChange={(e) => void update({ ai: { vision: { apiKey: e.target.value } } })}
            placeholder="Your own key"
            autoComplete="off"
          />
        </Field>

        <Toggle
          label="Use the vision provider to read on-screen text"
          description="Without this, FrameScript detects that text is present but does not read it."
          checked={settings.ai.useProviderForOcr}
          onChange={(v) => void update({ ai: { useProviderForOcr: v } })}
        />
      </fieldset>

      <fieldset className="fs-subsection" disabled={!settings.ai.remoteEnabled}>
        <legend>Speech recognition</legend>
        <Note>
          Chrome's built-in speech recognition cannot listen to a captured tab, so there is no local
          transcription option. Without a provider here, dialogue comes from platform subtitles only.
        </Note>
        <Field label="Provider" htmlFor="asr-provider">
          <select
            id="asr-provider"
            className="fs-select"
            value={settings.ai.asr.provider}
            onChange={(e) =>
              void update({ ai: { asr: { provider: e.target.value as 'none' | 'openai-compatible' } } })
            }
          >
            <option value="none">None</option>
            <option value="openai-compatible">OpenAI-compatible endpoint</option>
          </select>
        </Field>
        <Field label="Endpoint" htmlFor="asr-endpoint">
          <input
            id="asr-endpoint"
            className="fs-input"
            value={settings.ai.asr.endpoint}
            onChange={(e) => void update({ ai: { asr: { endpoint: e.target.value } } })}
            placeholder="https://api.openai.com/v1/audio/transcriptions"
          />
        </Field>
        <Field label="Model" htmlFor="asr-model">
          <input
            id="asr-model"
            className="fs-input"
            value={settings.ai.asr.model}
            onChange={(e) => void update({ ai: { asr: { model: e.target.value } } })}
          />
        </Field>
        <Field label="API key" htmlFor="asr-key">
          <input
            id="asr-key"
            className="fs-input"
            type="password"
            value={settings.ai.asr.apiKey}
            onChange={(e) => void update({ ai: { asr: { apiKey: e.target.value } } })}
            autoComplete="off"
          />
        </Field>
      </fieldset>

      <Note>
        Keys are stored in this browser's local extension storage and are never synced, logged, or sent
        anywhere except the endpoint you configured.
      </Note>
    </Section>
  );
}

function StorageSection() {
  const [items, setItems] = useState<ScreenplaySummary[]>([]);
  const [usage, setUsage] = useState(0);

  useEffect(() => {
    void screenplayRepository.list().then(setItems).catch(() => setItems([]));
    void screenplayRepository.estimateSize().then(setUsage).catch(() => setUsage(0));
  }, []);

  const remove = async (id: string) => {
    await screenplayRepository.delete(id);
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  const clearAll = async () => {
    await screenplayRepository.clear();
    setItems([]);
  };

  return (
    <Section
      title="Storage"
      description="Analysis runs in memory and disappears when the tab closes. Only screenplays you explicitly save are kept."
    >
      <p className="fs-secondary">
        {items.length} saved screenplay{items.length === 1 ? '' : 's'} · about {formatBytes(usage)} used
      </p>

      {items.length > 0 && (
        <ul className="fs-saved-list">
          {items.map((item) => (
            <li key={item.id} className="fs-saved">
              <div className="fs-stack">
                <span>{item.seriesTitle ?? item.title ?? item.contentId}</span>
                <span className="fs-muted">
                  {item.platform} · {item.sceneCount} scenes
                  {item.coverageRatio !== undefined && ` · ${Math.round(item.coverageRatio * 100)}% observed`}
                  {item.languages.length > 0 && ` · ${item.languages.join(', ')}`}
                </span>
              </div>
              <button className="fs-button fs-button--danger" onClick={() => void remove(item.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <button className="fs-button fs-button--danger" onClick={() => void clearAll()} disabled={items.length === 0}>
        Delete all saved screenplays
      </button>
    </Section>
  );
}

function PrivacySection({ settings, update }: SectionProps) {
  return (
    <Section title="Privacy" description="FrameScript is an analysis tool, not a recorder.">
      <dl className="fs-privacy">
        <PrivacyRow label="Analytics" value="None" />
        <PrivacyRow label="Telemetry" value="None" />
        <PrivacyRow label="Viewing history transmission" value="None" />
        <PrivacyRow label="Raw audio retention" value={settings.privacy.retainRawAudio ? 'On' : 'Off'} />
        <PrivacyRow label="Raw video retention" value={settings.privacy.retainRawVideo ? 'On' : 'Off'} />
        <PrivacyRow
          label="Remote AI"
          value={settings.ai.remoteEnabled && settings.ai.consentAcknowledged ? 'On' : 'Off'}
        />
        <PrivacyRow label="Local processing" value="Active" />
      </dl>

      <Note>
        Raw media retention is not implemented and these switches are read-only indicators. Captured audio and
        frames live in fixed-size in-memory buffers for a few seconds and are discarded once evidence has been
        derived. There is no code path in FrameScript that writes media to disk.
      </Note>

      <Toggle
        label="Keep saved screenplays"
        description="When off, the Save button is disabled and nothing is written to local storage."
        checked={settings.privacy.persistSavedScripts}
        onChange={(v) => void update({ privacy: { persistSavedScripts: v } })}
      />

      <div className="fs-consent">
        <h3>Current data transmission</h3>
        <ul>
          {describeDataTransmission(settings).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function AppearanceSection({ settings, update }: SectionProps) {
  return (
    <Section title="Appearance">
      <Field label="Theme" htmlFor="theme">
        <select
          id="theme"
          className="fs-select"
          value={settings.appearance.theme}
          onChange={(e) =>
            void update({ appearance: { theme: e.target.value as 'dark' | 'light' | 'system' } })
          }
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Follow the system</option>
        </select>
      </Field>

      <Field label={`Text size (${Math.round(settings.appearance.fontScale * 100)}%)`} htmlFor="font-scale">
        <input
          id="font-scale"
          type="range"
          min="0.85"
          max="1.4"
          step="0.05"
          value={settings.appearance.fontScale}
          onChange={(e) => void update({ appearance: { fontScale: Number(e.target.value) } })}
        />
      </Field>

      <Toggle
        label="Reduce motion"
        description="Also honoured automatically when your system requests reduced motion."
        checked={settings.appearance.reducedMotion}
        onChange={(v) => void update({ appearance: { reducedMotion: v } })}
      />
    </Section>
  );
}

function AdvancedSection({ settings, update }: SectionProps) {
  return (
    <Section title="Advanced">
      <Toggle
        label="Show diagnostics"
        description="Adds a diagnostics panel to the side panel with measured rates and source states. Nothing is transmitted."
        checked={settings.advanced.diagnosticsEnabled}
        onChange={(v) => void update({ advanced: { diagnosticsEnabled: v } })}
      />
      <Toggle
        label="Verbose logging"
        description="Detailed pipeline logging in the extension console."
        checked={settings.advanced.verboseLogging}
        onChange={(v) => void update({ advanced: { verboseLogging: v } })}
      />
      <button className="fs-button fs-button--danger" onClick={() => void settingsStore.reset()}>
        Reset all settings
      </button>
    </Section>
  );
}

// --- Primitives ----------------------------------------------------------------

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="fs-section">
      <h2>{title}</h2>
      {description && <p className="fs-section__description fs-secondary">{description}</p>}
      <div className="fs-section__body">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="fs-field">
      <label className="fs-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className={`fs-setting-toggle${disabled ? ' fs-setting-toggle--disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="fs-setting-toggle__body">
        <span>{label}</span>
        {description && <span className="fs-muted">{description}</span>}
      </span>
    </label>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="fs-note">{children}</p>;
}

function PrivacyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fs-privacy__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
