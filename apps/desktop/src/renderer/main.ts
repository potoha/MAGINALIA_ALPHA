import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Renderer root element was not found");
}

app.innerHTML = `
  <main class="shell" aria-labelledby="title">
    <p class="eyebrow">MAGINALIA</p>
    <h1 id="title">Before Kaldi</h1>
    <p class="status">Desktop shell placeholder</p>
  </main>
`;
