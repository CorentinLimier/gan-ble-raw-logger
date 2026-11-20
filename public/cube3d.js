/**
 * Minimal Three.js sticker-cube renderer for displaying the GAN cube's
 * decoded facelet state and live gyro orientation. Not an animated "twisty
 * player" — it just redraws all 54 sticker colors from the latest decoded
 * facelets string and rotates the whole cube group to match the reported
 * orientation quaternion. That is enough to sanity-check decoded MOVE/
 * FACELETS/GYRO events against the physical cube.
 */
import * as THREE from './vendor/three.min.js';

var FACE_COLORS = {
  U: 0xffffff,
  R: 0xc41e3a,
  F: 0x00843d,
  D: 0xffd500,
  L: 0xff8c00,
  B: 0x0051ba
};

var CubeRenderer = (function () {

  var renderer, scene, camera, cubeGroup, baseCube;
  var stickerMeshes = []; // index 0..53, Kociemba facelet order
  var container;

  var HOME_EULER = new THREE.Euler(20 * Math.PI / 180, -30 * Math.PI / 180, 0);
  var homeQuaternion = new THREE.Quaternion().setFromEuler(HOME_EULER);
  var targetQuaternion = homeQuaternion.clone();
  var basis = null; // gyro recalibration reference, null = not yet established

  var OFFSET = 1.52; // sticker distance from center along the face normal, just outside baseCube's 2.9-wide shell

  function faceletIndexToPosition(face, r, c) {
    // face: 0=U 1=R 2=F 3=D 4=L 5=B ; r,c in 0..2. The face's normal axis is
    // pushed out to OFFSET, the two in-plane axes use unit cubie spacing.
    switch (face) {
      case 0: return { x: c - 1, y: OFFSET, z: r - 1 };        // U
      case 1: return { x: OFFSET, y: 1 - r, z: 1 - c };        // R
      case 2: return { x: c - 1, y: 1 - r, z: OFFSET };        // F
      case 3: return { x: c - 1, y: -OFFSET, z: 1 - r };       // D
      case 4: return { x: -OFFSET, y: 1 - r, z: c - 1 };       // L
      case 5: return { x: 1 - c, y: 1 - r, z: -OFFSET };       // B
    }
  }

  var FACE_ROTATION = [
    new THREE.Euler(-Math.PI / 2, 0, 0), // U (+Y)
    new THREE.Euler(0, Math.PI / 2, 0),  // R (+X)
    new THREE.Euler(0, 0, 0),            // F (+Z)
    new THREE.Euler(Math.PI / 2, 0, 0),  // D (-Y)
    new THREE.Euler(0, -Math.PI / 2, 0), // L (-X)
    new THREE.Euler(0, Math.PI, 0)       // B (-Z)
  ];

  function init(el) {
    container = el;
    scene = new THREE.Scene();
    scene.background = null;

    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 9);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    var dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(3, 5, 6);
    scene.add(dir);

    cubeGroup = new THREE.Group();
    scene.add(cubeGroup);

    baseCube = new THREE.Mesh(
      new THREE.BoxGeometry(2.9, 2.9, 2.9),
      new THREE.MeshStandardMaterial({ color: 0x111318 })
    );
    cubeGroup.add(baseCube);

    var stickerGeom = new THREE.PlaneGeometry(0.82, 0.82);
    var faces = 'URFDLB';
    for (var face = 0; face < 6; face++) {
      for (var r = 0; r < 3; r++) {
        for (var c = 0; c < 3; c++) {
          var idx = face * 9 + r * 3 + c;
          var mat = new THREE.MeshStandardMaterial({ color: FACE_COLORS[faces[face]], side: THREE.FrontSide });
          var mesh = new THREE.Mesh(stickerGeom, mat);
          var pos = faceletIndexToPosition(face, r, c);
          var rot = FACE_ROTATION[face];
          mesh.position.set(pos.x, pos.y, pos.z);
          mesh.rotation.copy(rot);
          cubeGroup.add(mesh);
          stickerMeshes[idx] = mesh;
        }
      }
    }

    cubeGroup.quaternion.copy(targetQuaternion);

    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(animate);
  }

  function resize() {
    if (!container || !renderer) return;
    var w = container.clientWidth || 280;
    var h = w; // square viewport
    renderer.setSize(w, h, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }

  function animate() {
    cubeGroup.quaternion.slerp(targetQuaternion, 0.25);
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }

  var SOLVED = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

  function setFacelets(faceletsStr) {
    var s = faceletsStr || SOLVED;
    for (var i = 0; i < 54; i++) {
      var letter = s[i] || SOLVED[i];
      stickerMeshes[i].material.color.setHex(FACE_COLORS[letter] != null ? FACE_COLORS[letter] : 0x333333);
    }
  }

  /** GAN quaternion (x,y,z,w); axis remap (x,z,-y) matches gan-cube-sample's convention for this protocol's right-handed frame */
  function handleGyroEvent(q) {
    var quat = new THREE.Quaternion(q.x, q.z, -q.y, q.w).normalize();
    if (!basis) {
      basis = quat.clone().conjugate();
    }
    targetQuaternion.copy(quat.premultiply(basis).premultiply(homeQuaternion));
  }

  function resetGyro() {
    basis = null;
  }

  return {
    init: init,
    setFacelets: setFacelets,
    handleGyroEvent: handleGyroEvent,
    resetGyro: resetGyro
  };
})();

export { CubeRenderer };
