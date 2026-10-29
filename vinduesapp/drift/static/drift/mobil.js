// Mobil dagsrute: registreringer lægges i en lokal kø og sendes, når der er net.
// Samme event_id genbruges ved genforsøg, så serveren aldrig registrerer to gange.
(function () {
  const KOE = "vinduesapp-koe";
  const net = document.getElementById("net");
  const csrf = document.querySelector("meta[name=csrf]").content;

  function laes() { try { return JSON.parse(localStorage.getItem(KOE)) || []; } catch (e) { return []; } }
  function gem(k) { try { localStorage.setItem(KOE, JSON.stringify(k)); } catch (e) {} }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  }
  function visStatus(tekst, klasse) { net.textContent = tekst; net.className = "net " + (klasse || ""); }

  function opdaterKort(url, label, klasse) {
    const form = document.querySelector('form.reg[action="' + url + '"]');
    if (!form) return;
    const kort = form.closest(".stopkort");
    const pill = kort.querySelector("[data-status]");
    pill.textContent = label;
    pill.className = "pill " + (klasse || "");
    if (klasse !== "s-afventer") { form.remove(); kort.classList.add("final"); }
  }

  let koerer = false;
  async function send() {
    if (koerer) return;
    koerer = true;
    let koe = laes();
    while (koe.length) {
      const item = koe[0];
      let svar;
      try {
        svar = await fetch(item.url, {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
          body: JSON.stringify(item.data),
        });
      } catch (e) {
        visStatus("Offline – " + koe.length + " registrering(er) gemt på telefonen og sendes automatisk.", "off");
        koerer = false; return;
      }
      if (svar.status === 401 || svar.status === 403) {
        visStatus("Log ind igen for at sende " + koe.length + " gemt(e) registrering(er).", "ko");
        koerer = false; return;
      }
      const json = await svar.json().catch(() => ({}));
      if (svar.ok) {
        opdaterKort(item.url, json.status_label, "s-" + json.status);
        if (!json.created) visStatus(json.message, "ko");
      } else {
        // 409/400: konflikt eller ugyldigt – fjernes fra køen og vises tydeligt.
        visStatus("Konflikt: " + (json.message || "kunne ikke registreres") + " Tjek besøget.", "ko");
        opdaterKort(item.url, "Konflikt", "s-fejl");
      }
      koe = laes().filter(k => k.data.event_id !== item.data.event_id);
      gem(koe);
    }
    if (net.className.indexOf("off") >= 0) visStatus("");
    const faerdige = document.querySelectorAll(".stopkort.final").length;
    document.getElementById("taeller").textContent = faerdige;
    koerer = false;
  }

  document.querySelectorAll("form.reg").forEach(form => {
    form.addEventListener("submit", ev => {
      ev.preventDefault();
      if (form.dataset.sendt) return;              // dobbelttryk ignoreres
      const knap = ev.submitter;
      if (knap.value !== "udfoert" && !confirm("Registrér som '" + knap.textContent.trim() + "'?")) return;
      form.dataset.sendt = "1";
      form.querySelectorAll("button").forEach(b => b.disabled = true);
      const data = {
        event_id: uuid(), outcome: knap.value,
        note: form.note.value, price: form.price.value,
      };
      gem(laes().concat([{ url: form.getAttribute("action"), data: data }]));
      opdaterKort(form.getAttribute("action"), "Sendes…", "s-afventer");
      send();
    });
  });

  window.addEventListener("online", send);
  window.addEventListener("offline", () => visStatus("Offline – registreringer gemmes på telefonen.", "off"));
  if (!navigator.onLine) visStatus("Offline – registreringer gemmes på telefonen.", "off");
  setInterval(send, 30000);
  send();
})();
