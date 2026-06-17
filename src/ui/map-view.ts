import "leaflet/dist/leaflet.css";
import type { GeoFootprint, LatLng } from "../core/types.ts";

const FOOTPRINT_COLOR = "#ffaa00";

/**
 * Модалка с картой (Leaflet + OSM). Показывает контур среза Z=0, размещённый
 * по реальным координатам. Leaflet грузится лениво при первом открытии.
 */
export class MapView {
  // Leaflet типизируем как any: динамический импорт + UI-склейка.
  private L: any = null;
  private map: any = null;
  private layer: any = null;

  constructor(
    private modal: HTMLElement,
    private mapEl: HTMLElement,
    private methodEl: HTMLElement,
    private messageEl: HTMLElement,
    closeBtn: HTMLElement,
  ) {
    closeBtn.addEventListener("click", () => this.hide());
    this.modal.addEventListener("click", (e) => {
      if (e.target === this.modal) this.hide();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.modal.hidden) this.hide();
    });
  }

  /** Открывает модалку с сообщением вместо карты (нет привязки / пустой срез). */
  showMessage(text: string): void {
    this.modal.hidden = false;
    this.methodEl.textContent = "";
    this.mapEl.style.visibility = "hidden";
    this.messageEl.hidden = false;
    this.messageEl.textContent = text;
  }

  async show(footprint: GeoFootprint): Promise<void> {
    this.modal.hidden = false;
    this.messageEl.hidden = true;
    this.mapEl.style.visibility = "visible";
    await this.ensureMap();
    const L = this.L;

    this.methodEl.textContent = footprint.method;
    this.layer.clearLayers();

    const bounds = L.latLngBounds([]);
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;
    const draw = (pts: LatLng[], closed: boolean) => {
      const clean = pts.filter(isValidLatLng);
      if (clean.length < 2) return;
      const shape = closed
        ? L.polygon(clean, { color: FOOTPRINT_COLOR, weight: 3, fillOpacity: 0.3 })
        : L.polyline(clean, { color: FOOTPRINT_COLOR, weight: 3 });
      shape.addTo(this.layer);
      for (const p of clean) {
        bounds.extend(p);
        sumLat += p[0];
        sumLng += p[1];
        count++;
      }
    };

    for (const ring of footprint.rings) draw(ring, true);
    for (const line of footprint.lines) draw(line, false);

    if (count === 0) {
      // Контур есть, но координаты привязки невалидны — честно сообщаем.
      this.showMessage(
        "Контур получен, но координаты привязки некорректны — не удаётся разместить на карте.",
      );
      return;
    }

    // Заметный маркер на центре контура — чтобы объект было видно где угодно.
    const center: LatLng = [sumLat / count, sumLng / count];
    L.circleMarker(center, {
      radius: 8,
      color: "#ffffff",
      weight: 2,
      fillColor: FOOTPRINT_COLOR,
      fillOpacity: 1,
    })
      .addTo(this.layer)
      .bindTooltip("Объект (срез у основания)", { permanent: true, direction: "top" });

    // Карта внутри только что показанной модалки — нужно пересчитать размер.
    const fit = () => {
      this.map.invalidateSize();
      if (bounds.isValid())
        this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 20 });
      else this.map.setView(center, 18);
    };
    fit();
    setTimeout(fit, 80);
  }

  hide(): void {
    this.modal.hidden = true;
  }

  private async ensureMap(): Promise<void> {
    if (this.map) return;
    const mod: any = await import("leaflet");
    this.L = mod.default ?? mod;
    const L = this.L;
    this.map = L.map(this.mapEl, { zoomControl: true, maxZoom: 22 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      // OSM отдаёт тайлы до z19; глубже Leaflet растягивает их (без 400).
      maxNativeZoom: 19,
      maxZoom: 22,
      attribution: "© OpenStreetMap",
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
  }
}

function isValidLatLng(p: LatLng): boolean {
  return (
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1]) &&
    Math.abs(p[0]) <= 90 &&
    Math.abs(p[1]) <= 180
  );
}
