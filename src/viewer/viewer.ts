import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { IfcMeshData } from "../core/types.ts";

/** Колбэк выбора элемента кликом в сцене (null — клик по пустоте). */
export type SelectHandler = (expressID: number | null) => void;

const HIGHLIGHT_COLOR = new THREE.Color(0xffaa00);

/**
 * Минималистичный three.js-просмотрщик IFC-геометрии.
 * Принимает нейтральный IfcMeshData[] из ядра — не зависит от web-ifc.
 */
export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private modelGroup = new THREE.Group();

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  /** expressID → меши элемента (у элемента может быть несколько геометрий). */
  private byExpressID = new Map<number, THREE.Mesh[]>();
  private highlighted: { mesh: THREE.Mesh; material: THREE.Material }[] = [];

  private onSelect: SelectHandler = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1e1f23);
    this.scene.add(this.modelGroup);

    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.01,
      10000,
    );
    this.camera.position.set(10, 10, 10);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.addLights();
    this.addGround();

    this.renderer.domElement.addEventListener("click", this.handleClick);
    window.addEventListener("resize", this.handleResize);

    this.animate();
  }

  setSelectHandler(handler: SelectHandler): void {
    this.onSelect = handler;
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(50, 80, 30);
    this.scene.add(dir);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
  }

  private addGround(): void {
    const grid = new THREE.GridHelper(100, 100, 0x444444, 0x2a2b2f);
    (grid.material as THREE.Material).opacity = 0.4;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);
  }

  /** Загружает геометрию модели в сцену, очищая предыдущую. */
  loadMeshes(meshes: IfcMeshData[]): void {
    this.clear();

    for (const data of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(data.positions, 3),
      );
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(data.normals, 3),
      );
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

      // Матрица размещения из web-ifc — column-major, "запекаем" в вершины.
      geometry.applyMatrix4(new THREE.Matrix4().fromArray(data.matrix));

      const material = new THREE.MeshLambertMaterial({
        color: new THREE.Color(data.color.r, data.color.g, data.color.b),
        side: THREE.DoubleSide,
        transparent: data.color.a < 1,
        opacity: data.color.a,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.expressID = data.expressID;
      this.modelGroup.add(mesh);

      const list = this.byExpressID.get(data.expressID) ?? [];
      list.push(mesh);
      this.byExpressID.set(data.expressID, list);
    }

    this.fitToModel();
  }

  /** Программно подсветить и навести камеру на элемент (из дерева/списка). */
  focus(expressID: number | null): void {
    this.highlight(expressID);
  }

  /** Полностью очищает сцену от загруженной модели. */
  clear(): void {
    this.restoreHighlight();
    for (const mesh of this.modelGroup.children) {
      const m = mesh as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    }
    this.modelGroup.clear();
    this.byExpressID.clear();
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────

  private handleClick = (event: MouseEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.modelGroup.children, false);
    const id = hits.length
      ? (hits[0].object.userData.expressID as number)
      : null;
    this.highlight(id);
    this.onSelect(id);
  };

  private highlight(expressID: number | null): void {
    this.restoreHighlight();
    if (expressID == null) return;
    const meshes = this.byExpressID.get(expressID);
    if (!meshes) return;
    for (const mesh of meshes) {
      this.highlighted.push({ mesh, material: mesh.material as THREE.Material });
      mesh.material = new THREE.MeshLambertMaterial({
        color: HIGHLIGHT_COLOR,
        side: THREE.DoubleSide,
        emissive: HIGHLIGHT_COLOR,
        emissiveIntensity: 0.35,
      });
    }
  }

  private restoreHighlight(): void {
    for (const { mesh, material } of this.highlighted) {
      (mesh.material as THREE.Material).dispose();
      mesh.material = material;
    }
    this.highlighted = [];
  }

  private fitToModel(): void {
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    this.controls.target.copy(center);
    const dist = maxDim * 1.6;
    this.camera.position.set(
      center.x + dist,
      center.y + dist * 0.8,
      center.z + dist,
    );
    this.camera.near = maxDim / 1000;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private handleResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
