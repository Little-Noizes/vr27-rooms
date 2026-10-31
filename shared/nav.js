// E-LAB VR27: "All rooms" link shown on every room page (top right). One file so the site nav changes in one place.
(() => {
  const css = `
  .elab-nav { position: fixed; top: 14px; right: 14px; z-index: 50; display: flex; align-items: center; gap: 10px;
    padding: 7px 12px 7px 10px; border-radius: 999px; background: rgba(18, 16, 26, 0.78); color: #fff;
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); text-decoration: none;
    font: 500 13px/1 "Instrument Sans", "IBM Plex Sans Condensed", system-ui, sans-serif; letter-spacing: 0.01em;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); transition: background 0.15s; }
  .elab-nav:hover { background: rgba(18, 16, 26, 0.92); }
  .elab-nav:focus-visible { outline: 2px solid #9e6aff; outline-offset: 2px; }
  .elab-nav svg { height: 15px; width: auto; display: block; }
  .elab-nav .sep { width: 1px; height: 14px; background: rgba(255, 255, 255, 0.3); }
  @media (max-width: 640px) { .elab-nav { top: 10px; right: 10px; padding: 6px 10px; } .elab-nav .lbl { display: none; } }`;
  const logo = `<svg viewBox="238 438 232 64" role="img" aria-label="E-LAB"><g fill="#fff">
    <path d="M278.94,442.12h-37.63c-.1,0-.18.08-.18.18v4.02l.08,47.43,4.69,4.66h33.04v-6.27l-30.64-.04.06-43.71h30.58v-6.27Z"/>
    <polygon points="324.49 448.4 324.5 442.12 317.26 442.12 317.26 446.33 317.34 493.76 322.87 498.42 355.08 498.42 355.08 492.15 324.43 492.11 324.49 448.4"/>
    <rect x="286.23" y="465.93" width="17.63" height="6.27"/>
    <path d="M446.07,468.76c5.62-.48,11.16-4.68,11.16-12.9,0-11.02-7.73-13.74-21.31-13.74h-18.58v56.3h21.86c13.5,0,22.09-3.51,22.09-15.01,0-10.14-6.79-14.41-15.22-14.65ZM424.45,468.55v-20.52h11.79c8.66,0,13.97.56,13.97,9.1,0,6.22-3.34,8.29-8.95,8.89l-16.86.07.03,2.61,3.46,3.41h15.05c7.04.55,11.25,3.05,11.25,10.1,0,8.7-5.54,10.14-14.75,10.14h-14.99v-23.93"/>
    <polygon points="252.68 468.48 255.83 472.18 269.54 472.18 269.54 466.08 252.68 466.08 252.68 468.48"/>
    <polygon points="390.08 442.1 382.86 442.1 404.36 498.42 411.77 498.42 390.08 442.1"/></g>
    <polygon fill="#9e6aff" points="368 498.42 360.78 498.42 370.81 472.18 378.12 472.18 368 498.42"/></svg>`;
  const add = () => {
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    const a = document.createElement("a");
    a.className = "elab-nav"; a.href = "../../"; a.title = "Back to all rooms";
    a.innerHTML = `<span aria-hidden="true">&larr;</span><span class="lbl">All rooms</span><span class="sep" aria-hidden="true"></span>${logo}`;
    document.body.appendChild(a);
  };
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();
