const GITHUB = 'https://github.com/lucanomics/framescript';

export function DocsPage() {
  return (
    <div className="docs-page">
      <header className="site-header">
        <a className="brand" href="/">
          FRAMESCRIPT
        </a>
        <nav aria-label="Documentation navigation">
          <a href="/">Product</a>
          <a href="/studio">Studio</a>
          <a href={GITHUB}>GitHub</a>
        </nav>
      </header>
      <main className="docs-layout section">
        <aside>
          <p className="kicker">Documentation</p>
          <nav aria-label="On this page">
            <a href="#surfaces">Product surfaces</a>
            <a href="#studio">Web Studio</a>
            <a href="#extension">Chrome Extension</a>
            <a href="#projects">Project files</a>
            <a href="#privacy">Privacy</a>
            <a href="#development">Development</a>
          </nav>
        </aside>
        <article className="docs-content">
          <h1>FrameScript documentation</h1>
          <p className="docs-lede">
            FrameScript reconstructs structured screenplays from timed evidence. It has four product
            surfaces over one shared core, and each surface stays inside the privileges of its
            environment.
          </p>
          <DocSection id="surfaces" title="Product surfaces">
            <dl className="definition-list">
              <div>
                <dt>Shared Core</dt>
                <dd>
                  Evidence, temporal analysis, multilingual alignment, scene reconstruction,
                  provenance, coverage, conflicts, rendering, and export.
                </dd>
              </div>
              <div>
                <dt>Web Studio</dt>
                <dd>
                  Local files, project review, language views, search, diagnostics, and export.
                </dd>
              </div>
              <div>
                <dt>Chrome Extension</dt>
                <dd>
                  YouTube and Netflix player integration, live subtitle and playback evidence, tab
                  media capture, and YouTube quality control.
                </dd>
              </div>
              <div>
                <dt>CLI / MCP</dt>
                <dd>
                  File-based automation, scripting, batch conversion, and agent interoperability.
                </dd>
              </div>
            </dl>
          </DocSection>
          <DocSection id="studio" title="Web Studio">
            <p>
              Studio accepts SRT, WebVTT, supported browser-decodable video and audio, and versioned
              FrameScript JSON projects. Multiple subtitle languages are aligned into one scene
              structure. Media is read with browser File APIs and the file itself is never uploaded.
            </p>
            <p>
              Speech detection, speaker clustering, sound, silence, motion and scene changes are
              computed on your device. Turning detected speech into dialogue, and turning a scene
              into a description, require a model. Studio shows which of those a deployment has
              configured before you start, and reports how much of the detected speech was actually
              transcribed rather than implying a full script.
            </p>
            <a className="button button--primary" href="/studio">
              Open Studio
            </a>
          </DocSection>
          <DocSection id="extension" title="Chrome Extension">
            <p>
              A website cannot inspect another origin’s player. Live YouTube and Netflix workflows
              therefore belong to the Chrome extension. The safest Studio handoff is a native
              FrameScript JSON project: export from the extension, then open that file in Studio.
            </p>
            <p>
              Netflix picture access and stream quality remain constrained by protected playback.
              FrameScript reports those limits and does not bypass them.
            </p>
          </DocSection>
          <DocSection id="projects" title="Project files">
            <p>
              FrameScript JSON uses an explicit format and version. Current exports preserve scenes,
              characters, multilingual dialogue variants, line provenance, coverage diagnostics,
              conflicts, source summaries, and metadata when available. Newer unknown versions are
              rejected rather than partially rewritten.
            </p>
          </DocSection>
          <DocSection id="privacy" title="Privacy">
            <p>
              Studio has no account, no analytics and no client-side secret, and local-only
              workflows — subtitles, projects, and structural media analysis — reach no server at
              all. When transcription or scene understanding is enabled, the request goes to this
              site’s own endpoint, which holds the provider credential server-side: the browser
              never sees a key. What is sent is bounded to the detected speech windows and the
              selected keyframes, and nothing is stored. The extension’s remote model integrations
              are separate, opt-in, and configured with your own key in the extension.
            </p>
          </DocSection>
          <DocSection id="development" title="Development and deployment">
            <pre>
              <code>{`npm ci
npm run dev:web
npm run verify
npm run test:e2e`}</code>
            </pre>
            <p>
              The Studio is a static Vite build. Build with <code>npm run build:web</code> and
              deploy <code>dist-web</code>. Vercel rewrites app routes such as <code>/studio</code>{' '}
              to the static shell.
            </p>
            <p>
              See the complete architecture, privacy, performance, platform limitation, and QA
              documents in the repository.
            </p>
          </DocSection>
        </article>
      </main>
    </div>
  );
}

function DocSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
