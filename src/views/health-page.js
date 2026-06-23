function renderHealthPage(options) {
    const status = options.ok ? "Online" : "Attention";
    const checkedAt = options.timestamp || new Date().toISOString();

    return `<!doctype html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)} - ${status}</title>
    <style>
        :root {
            color-scheme: light dark;
            --ink: #17202a;
            --muted: #5f6c7b;
            --panel: rgba(255, 255, 255, 0.88);
            --line: rgba(23, 32, 42, 0.12);
            --green: #18a058;
            --blue: #0f6cbd;
            --cyan: #1ba7a6;
            --gold: #d89100;
            --shadow: 0 24px 80px rgba(15, 39, 71, 0.18);
        }

        * {
            box-sizing: border-box;
        }

        body {
            min-height: 100vh;
            margin: 0;
            display: grid;
            place-items: center;
            padding: 32px;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: var(--ink);
            background:
                radial-gradient(circle at 18% 20%, rgba(27, 167, 166, 0.22), transparent 28%),
                radial-gradient(circle at 82% 12%, rgba(15, 108, 189, 0.18), transparent 30%),
                linear-gradient(135deg, #eef7f6 0%, #f7f9fc 48%, #f4f0e8 100%);
        }

        main {
            width: min(920px, 100%);
            border: 1px solid var(--line);
            border-radius: 18px;
            background: var(--panel);
            box-shadow: var(--shadow);
            overflow: hidden;
            backdrop-filter: blur(14px);
        }

        .top {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 24px;
            padding: 34px;
            border-bottom: 1px solid var(--line);
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 16px;
        }

        .mark {
            width: 56px;
            height: 56px;
            border-radius: 16px;
            display: grid;
            place-items: center;
            color: white;
            font-weight: 800;
            font-size: 22px;
            background: linear-gradient(135deg, var(--cyan), var(--blue));
            box-shadow: 0 16px 32px rgba(15, 108, 189, 0.24);
        }

        h1 {
            margin: 0;
            font-size: clamp(28px, 4vw, 44px);
            line-height: 1.05;
            letter-spacing: 0;
        }

        .subtitle {
            margin: 8px 0 0;
            color: var(--muted);
            font-size: 16px;
        }

        .status {
            align-self: start;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border-radius: 999px;
            border: 1px solid rgba(24, 160, 88, 0.28);
            background: rgba(24, 160, 88, 0.11);
            color: #11693c;
            font-weight: 750;
            white-space: nowrap;
        }

        .dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: var(--green);
            box-shadow: 0 0 0 7px rgba(24, 160, 88, 0.14);
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1px;
            background: var(--line);
        }

        .metric {
            min-height: 130px;
            padding: 24px;
            background: rgba(255, 255, 255, 0.66);
        }

        .label {
            margin: 0 0 10px;
            color: var(--muted);
            font-size: 13px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .value {
            margin: 0;
            font-size: 18px;
            font-weight: 760;
            overflow-wrap: anywhere;
        }

        .footer {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 20px 34px;
            color: var(--muted);
            font-size: 14px;
            background: rgba(255, 255, 255, 0.48);
        }

        code {
            color: var(--blue);
            font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
            font-size: 13px;
        }

        @media (max-width: 720px) {
            body {
                padding: 18px;
            }

            .top {
                grid-template-columns: 1fr;
                padding: 24px;
            }

            .grid {
                grid-template-columns: 1fr;
            }

            .footer {
                flex-direction: column;
                padding: 18px 24px;
            }
        }
    </style>
</head>
<body>
    <main>
        <section class="top">
            <div class="brand">
                <div class="mark">AV</div>
                <div>
                    <h1>${escapeHtml(options.title)}</h1>
                    <p class="subtitle">${escapeHtml(options.subtitle)}</p>
                </div>
            </div>
            <div class="status"><span class="dot"></span>${status}</div>
        </section>

        <section class="grid">
            ${metric("Servicio", options.service)}
            ${metric("Ambiente", options.environment)}
            ${metric("Modulo", options.module)}
        </section>

        <div class="footer">
            <span>Ultima verificacion: ${escapeHtml(checkedAt)}</span>
            <code>${escapeHtml(options.endpoint)}</code>
        </div>
    </main>
</body>
</html>`;
}

function metric(label, value) {
    return `<article class="metric">
        <p class="label">${escapeHtml(label)}</p>
        <p class="value">${escapeHtml(value || "-")}</p>
    </article>`;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

module.exports = renderHealthPage;
