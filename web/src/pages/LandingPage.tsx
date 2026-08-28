const GITHUB = 'https://github.com/lucanomics/framescript';

export function LandingPage() {
  return (
    <div className="site-shell">
      <SiteHeader />
      <main>
        <section className="hero section" aria-labelledby="hero-title">
          <div className="hero__copy">
            <h1 id="hero-title">
              Turn video into a structured <em>screenplay.</em>
            </h1>
            <p>
              Reconstruct dialogue, scenes, sound, action, and timing from the evidence your media
              actually contains.
            </p>
            <div className="hero__actions">
              <a className="button button--primary button--large" href="/studio">
                Open Studio <span aria-hidden="true">→</span>
              </a>
              <a className="button button--large" href="/docs#extension">
                Chrome Extension
              </a>
            </div>
          </div>
          <ProductPreview />
        </section>

        <section className="process" aria-labelledby="process-title">
          <div className="section process__inner">
            <h2 id="process-title" className="visually-hidden">
              How FrameScript works
            </h2>
            {[
              ['01', 'Media', 'Files you choose or playback the extension can observe.'],
              ['02', 'Evidence', 'Timed subtitle, audio, visual, metadata, and user evidence.'],
              ['03', 'Scenes', 'Evidence is aligned into a single structured scene model.'],
              ['04', 'Screenplay', 'Readable language views retain provenance and uncertainty.'],
            ].map(([number, title, body]) => (
              <div className="process__step" key={number}>
                <span className="process__number">{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="section product-story" aria-labelledby="one-engine">
          <SectionHeading
            kicker="One evidence model"
            title="One engine. Four focused surfaces."
            id="one-engine"
          >
            FrameScript keeps platform privileges at the edges and reconstruction in the shared
            core.
          </SectionHeading>
          <div className="surface-map">
            <div className="surface-map__core">
              <span className="surface-map__mark">F</span>
              <strong>Shared Core</strong>
              <span>Evidence · alignment · scenes · provenance</span>
            </div>
            <div className="surface-map__rail" aria-hidden="true" />
            <div className="surface-map__list">
              <Surface
                title="Web Studio"
                body="Open local video, audio, subtitle, and FrameScript project files. Review, search, inspect, and export in the browser."
              />
              <Surface
                title="Chrome Extension"
                body="Observe supported live YouTube and Netflix playback, collect evidence, and keep YouTube at the best available quality."
              />
              <Surface
                title="CLI / MCP"
                body="Run file-based reconstruction in scripts, batch workflows, developer tools, and AI-agent integrations."
              />
            </div>
          </div>
          <p className="boundary-note">
            <span aria-hidden="true">ⓘ</span> Your own files belong in Studio. Live YouTube and
            Netflix playback requires the Chrome Extension.
          </p>
        </section>

        <section className="language-band" aria-labelledby="languages-title">
          <div className="section language-band__inner">
            <SectionHeading
              kicker="Multilingual by structure"
              title="One timeline. Many languages."
              id="languages-title"
              compact
            >
              Aligned subtitle tracks become variants of the same dialogue beats—not duplicate
              scenes.
            </SectionHeading>
            <LanguageTimeline />
            <div className="language-paper" aria-label="Example multilingual screenplay">
              <ScriptSample label="ENGLISH · EN" heading="INT. APARTMENT — NIGHT" character="MAYA">
                You’re late.
              </ScriptSample>
              <ScriptSample
                label="한국어 · KO"
                heading="INT. 아파트 — 밤"
                character="마야"
                lang="ko"
              >
                늦었네.
              </ScriptSample>
              <ScriptSample
                label="日本語 · JA"
                heading="INT. アパート — 夜"
                character="マヤ"
                lang="ja"
              >
                遅いわね。
              </ScriptSample>
            </div>
          </div>
        </section>

        <section className="section trust-section" aria-labelledby="trust-title">
          <SectionHeading
            kicker="Evidence, not invention"
            title="Inspect what’s known. See what isn’t."
            id="trust-title"
            compact
          >
            Every screenplay beat retains its sources, ordinal confidence, and whether it was
            observed or inferred. Disagreement and incomplete coverage remain visible.
          </SectionHeading>
          <div className="trust-table" role="list" aria-label="FrameScript evidence states">
            {[
              ['Observed', 'Direct support from a source', 'Subtitle: “We need to talk.”'],
              [
                'Inferred',
                'A conclusion beyond literal source text',
                'Setting description · medium',
              ],
              ['Uncertain', 'More than one explanation remains', 'Speaker identity unknown'],
              ['Conflict', 'Two sources disagree', 'Subtitle vs. audio transcription'],
              ['Incomplete', 'A media range was not observed', '02:14–02:31 unobserved'],
            ].map(([state, meaning, example]) => (
              <div className="trust-table__row" role="listitem" key={state}>
                <strong>{state}</strong>
                <span>{meaning}</span>
                <code>{example}</code>
              </div>
            ))}
          </div>
        </section>

        <section className="privacy-band" aria-labelledby="privacy-title">
          <div className="section privacy-band__inner">
            <SectionHeading
              kicker="Your media stays local"
              title="Local in. Structured out."
              id="privacy-title"
              compact
            >
              Studio reads files through browser APIs and runs the shared FrameScript engine on your
              device.
            </SectionHeading>
            <div className="privacy-flow" aria-label="Local processing flow">
              <FlowStep title="Browser File APIs" body="You choose the files." />
              <span aria-hidden="true">→</span>
              <FlowStep title="Evidence timeline" body="Sources align locally." />
              <span aria-hidden="true">→</span>
              <FlowStep title="Screenplay" body="Review and export locally." />
            </div>
            <p className="privacy-statement">No upload. No account. No analytics.</p>
          </div>
        </section>

        <section className="section final-cta">
          <div>
            <span className="final-cta__mark" aria-hidden="true">
              F
            </span>
            <h2>Build from what was actually observed.</h2>
          </div>
          <div>
            <a className="button button--primary button--large" href="/studio">
              Open Studio <span aria-hidden="true">→</span>
            </a>
            <a className="button button--large" href="/docs#extension">
              Chrome Extension <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="FrameScript home">
        FRAMESCRIPT
      </a>
      <nav aria-label="Main navigation">
        <a href="#one-engine">Product</a>
        <a href="/studio">Studio</a>
        <a href="/docs">Docs</a>
        <a href={GITHUB} rel="noreferrer">
          GitHub
        </a>
      </nav>
      <a className="site-header__studio" href="/studio">
        Open Studio
      </a>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer section">
      <div>
        <a className="brand" href="/">
          FRAMESCRIPT
        </a>
        <span>Structure by evidence.</span>
      </div>
      <nav aria-label="Footer navigation">
        <a href="#one-engine">Product</a>
        <a href="/studio">Studio</a>
        <a href="/docs">Docs</a>
        <a href={GITHUB} rel="noreferrer">
          GitHub
        </a>
        <a href="/docs#privacy">Privacy</a>
      </nav>
    </footer>
  );
}

function ProductPreview() {
  return (
    <div className="product-preview" aria-label="FrameScript Studio preview">
      <div className="product-preview__top">
        <span>episode.en.srt</span>
        <span>EN ↔ KO</span>
      </div>
      <div className="product-preview__body">
        <aside aria-label="Example scene list">
          <span>SCENES</span>
          <button type="button" className="is-selected">
            01 · 0:05
          </button>
          <button type="button">02 · 0:30</button>
          <button type="button">03 · 1:04</button>
        </aside>
        <div className="preview-paper">
          <strong>INT. UNKNOWN SETTING — NIGHT</strong>
          <p className="script-character">JIYEON</p>
          <p>We’re out of milk.</p>
          <p className="script-secondary" lang="ko">
            우유가 없네.
          </p>
          <p className="script-character">DANIEL</p>
          <p>I’ll get some.</p>
        </div>
        <div className="preview-evidence">
          <span>EVIDENCE</span>
          <p>
            <b>Subtitle</b>
            <small>OBSERVED · HIGH</small>
          </p>
          <p>
            <b>Speaker label</b>
            <small>OBSERVED · MEDIUM</small>
          </p>
          <p>
            <b>Setting</b>
            <small>UNKNOWN</small>
          </p>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({
  kicker,
  title,
  id,
  compact = false,
  children,
}: {
  kicker: string;
  title: string;
  id: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={'section-heading' + (compact ? ' section-heading--compact' : '')}>
      <p className="kicker">{kicker}</p>
      <h2 id={id}>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
function Surface({ title, body }: { title: string; body: string }) {
  return (
    <article>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}
function ScriptSample({
  label,
  heading,
  character,
  lang,
  children,
}: {
  label: string;
  heading: string;
  character: string;
  lang?: string;
  children: React.ReactNode;
}) {
  return (
    <div lang={lang}>
      <span>{label}</span>
      <strong>{heading}</strong>
      <p className="script-character">{character}</p>
      <p>{children}</p>
    </div>
  );
}
function LanguageTimeline() {
  return (
    <div className="language-timeline" aria-label="Three subtitle tracks aligned to shared scenes">
      {['EN  English', 'KO  한국어', 'JA  日本語'].map((label) => (
        <div key={label}>
          <span>{label}</span>
          <i />
          <b />
          <b />
          <b />
          <b />
        </div>
      ))}
    </div>
  );
}
function FlowStep({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}
