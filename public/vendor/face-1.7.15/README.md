# Face finding for Glint People

Vendored so Roost never loads anything from outside. Nothing in here is edited.

- `face-api.js`: @vladmandic/face-api 1.7.15 (MIT), a maintained build of face-api.js with TensorFlow.js inside.
- `model/ssd_mobilenetv1_model*`: face detector (SSD MobileNet v1), MIT, from the face-api.js project.
- `model/face_landmark_68_tiny_model*`: tiny 68-point landmark model, MIT, same project. Used to straighten each face.
- `model/face_recognition_model*`: the 128-number face fingerprint. A port of dlib's `dlib_face_recognition_resnet_model_v1`, which Davis King released into the public domain.

Only a browser with Glint's People switched on downloads these (about 12 MB, once; they are cached for a year).
Update by replacing the folder with a newer package's files and changing the folder name (and the path in `public/faces.js`).
