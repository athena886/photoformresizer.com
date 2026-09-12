(function () {
  "use strict";

  var SPECS = Object.freeze({
    photo: Object.freeze({
      label: "photograph",
      width: 197,
      height: 276,
      maxBytes: 20 * 1024
    }),
    signature: Object.freeze({
      label: "signature",
      width: 354,
      height: 158,
      maxBytes: 10 * 1024
    })
  });

  var applicantInput = document.getElementById("applicant-name");
  var editorInstances = [];
  var editorByRoot = new WeakMap();

  function numberAttribute(root, name, fallback) {
    var value = Number(root.getAttribute(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function editorSpec(kind, root) {
    var fallback = SPECS[kind];
    return {
      label: fallback.label,
      width: Math.round(numberAttribute(root, "data-width", fallback.width)),
      height: Math.round(numberAttribute(root, "data-height", fallback.height)),
      dpi: Math.round(numberAttribute(root, "data-dpi", 200)),
      minBytes: Math.round(numberAttribute(root, "data-min-kb", 0) * 1024),
      maxBytes: Math.round(numberAttribute(root, "data-max-kb", fallback.maxBytes / 1024) * 1024)
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function setStatus(element, message, tone) {
    element.textContent = message;
    if (tone) {
      element.setAttribute("data-tone", tone);
    } else {
      element.removeAttribute("data-tone");
    }
  }

  function setButtonBusy(button, busy, busyLabel) {
    if (busy) {
      if (!button.hasAttribute("data-idle-label")) {
        button.setAttribute("data-idle-label", button.textContent);
      }
      button.disabled = true;
      button.textContent = busyLabel;
      return;
    }

    button.disabled = false;
    button.textContent = button.getAttribute("data-idle-label") || button.textContent;
    button.removeAttribute("data-idle-label");
  }

  function safeApplicantName() {
    if (!applicantInput) {
      return "";
    }

    return applicantInput.value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60);
  }

  function filePrefix(root) {
    var prefix = root && root.getAttribute("data-file-prefix");
    if (!prefix) {
      return "nsdl-pan";
    }
    return prefix.replace(/[^a-zA-Z0-9-]/g, "") || "nsdl-pan";
  }

  function outputFileName(kind, root) {
    var baseName = filePrefix(root) + (kind === "photo" ? "-photo.jpg" : "-signature.jpg");
    var applicantName = safeApplicantName();
    return applicantName ? applicantName + "-" + baseName : baseName;
  }

  function zipFileName(root) {
    var prefix = filePrefix(root);
    var baseName = prefix === "nsdl-pan" ? "NSDL-PAN" : prefix + "-photo-and-signature";
    var applicantName = safeApplicantName();
    return applicantName ? baseName + "-" + applicantName + ".zip" : baseName + ".zip";
  }

  function formatFileSize(bytes) {
    var kilobytes = bytes / 1024;
    return (kilobytes < 9.95 ? kilobytes.toFixed(1) : Math.round(kilobytes)) + " KB";
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("The browser could not create the JPEG file."));
        }
      }, "image/jpeg", quality);
    });
  }

  function ensureJfifDensity(blob, dpi) {
    var density = Number(dpi) || 200;

    return blob.arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
        throw new Error("The browser returned an invalid JPEG file.");
      }

      var offset = 2;
      while (offset + 4 <= bytes.length) {
        if (bytes[offset] !== 0xFF) {
          offset += 1;
          continue;
        }

        var marker = bytes[offset + 1];
        if (marker === 0xDA) {
          break;
        }

        if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
          offset += 2;
          continue;
        }

        var segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
          break;
        }

        var isJfif = marker === 0xE0 &&
          segmentLength >= 16 &&
          bytes[offset + 4] === 0x4A &&
          bytes[offset + 5] === 0x46 &&
          bytes[offset + 6] === 0x49 &&
          bytes[offset + 7] === 0x46 &&
          bytes[offset + 8] === 0x00;

        if (isJfif) {
          bytes[offset + 11] = 1;
          bytes[offset + 12] = (density >> 8) & 0xFF;
          bytes[offset + 13] = density & 0xFF;
          bytes[offset + 14] = (density >> 8) & 0xFF;
          bytes[offset + 15] = density & 0xFF;
          return new Blob([bytes], { type: "image/jpeg" });
        }

        offset += 2 + segmentLength;
      }

      var app0 = new Uint8Array([
        0xFF, 0xE0, 0x00, 0x10,
        0x4A, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01,
        0x01,
        (density >> 8) & 0xFF, density & 0xFF,
        (density >> 8) & 0xFF, density & 0xFF,
        0x00, 0x00
      ]);
      var withHeader = new Uint8Array(bytes.length + app0.length);
      withHeader[0] = bytes[0];
      withHeader[1] = bytes[1];
      withHeader.set(app0, 2);
      withHeader.set(bytes.subarray(2), 2 + app0.length);
      return new Blob([withHeader], { type: "image/jpeg" });
    });
  }

  function padJpegToMinimum(blob, minBytes) {
    if (!minBytes || blob.size >= minBytes) {
      return Promise.resolve(blob);
    }

    return blob.arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes.length < 2 || bytes[bytes.length - 2] !== 0xFF || bytes[bytes.length - 1] !== 0xD9) {
        return blob;
      }

      var segmentSize = Math.max(4, minBytes - bytes.length);
      var payloadLength = segmentSize - 4;
      var comment = new Uint8Array(segmentSize);
      var commentLength = payloadLength + 2;
      comment[0] = 0xFF;
      comment[1] = 0xFE;
      comment[2] = (commentLength >> 8) & 0xFF;
      comment[3] = commentLength & 0xFF;
      for (var index = 4; index < comment.length; index += 1) {
        comment[index] = 0x20;
      }

      var padded = new Uint8Array(bytes.length + comment.length);
      padded.set(bytes.subarray(0, bytes.length - 2), 0);
      padded.set(comment, bytes.length - 2);
      padded[padded.length - 2] = 0xFF;
      padded[padded.length - 1] = 0xD9;
      return new Blob([padded], { type: "image/jpeg" });
    });
  }

  function createJpegAtQuality(canvas, quality, dpi, minBytes) {
    return canvasToBlob(canvas, quality)
      .then(function (blob) {
        return ensureJfifDensity(blob, dpi);
      })
      .then(function (blob) {
        return padJpegToMinimum(blob, minBytes);
      });
  }

  function encodeToLimit(canvas, maxBytes, dpi, minBytes) {
    return createJpegAtQuality(canvas, 0.4, dpi, minBytes).then(function (minimumBlob) {
      if (minimumBlob.size > maxBytes) {
        return null;
      }

      return createJpegAtQuality(canvas, 0.98, dpi, minBytes).then(function (maximumBlob) {
        if (maximumBlob.size <= maxBytes) {
          return {
            blob: maximumBlob,
            quality: 0.98
          };
        }

        var low = 0.4;
        var high = 0.98;
        var bestBlob = minimumBlob;
        var bestQuality = 0.4;

        function search(index) {
          if (index >= 10) {
            return Promise.resolve({
              blob: bestBlob,
              quality: bestQuality
            });
          }

          var midpoint = (low + high) / 2;
          return createJpegAtQuality(canvas, midpoint, dpi, minBytes).then(function (blob) {
            if (blob.size <= maxBytes) {
              bestBlob = blob;
              bestQuality = midpoint;
              low = midpoint;
            } else {
              high = midpoint;
            }
            return search(index + 1);
          });
        }

        return search(0);
      });
    });
  }

  function renderJpeg(editor) {
    var state = editor.state;
    var spec = editor.spec;

    if (!state.image) {
      return Promise.reject(new Error("Please upload an image first."));
    }

    var crop = {
      x: state.crop.x,
      y: state.crop.y,
      width: state.crop.width,
      height: state.crop.height
    };

    function attempt(scale, attemptNumber) {
      var width = Math.max(1, Math.round(spec.width * scale));
      var height = Math.max(1, Math.round(spec.height * scale));
      var canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      var context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        state.image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        width,
        height
      );

      return encodeToLimit(canvas, spec.maxBytes, spec.dpi, spec.minBytes).then(function (result) {
        if (result) {
          return {
            blob: result.blob,
            width: width,
            height: height,
            quality: result.quality
          };
        }

        if (attemptNumber >= 9) {
          throw new Error("The image could not be reduced below the required file size.");
        }

        return attempt(scale * 0.9, attemptNumber + 1);
      });
    }

    return attempt(1, 0);
  }

  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function makeEditor(root) {
    var kind = root.getAttribute("data-kind");
    var spec = editorSpec(kind, root);
    var fileInput = root.querySelector("[data-file]");
    var workspace = root.querySelector("[data-workspace]");
    var canvas = root.querySelector("[data-canvas]");
    var zoomInput = root.querySelector("[data-zoom]");
    var downloadButton = root.querySelector("[data-download]");
    var status = root.querySelector("[data-status]");
    var context = canvas.getContext("2d");

    var state = {
      image: null,
      imageUrl: "",
      baseCrop: { width: 0, height: 0 },
      crop: { x: 0, y: 0, width: 0, height: 0 },
      centerX: 0,
      centerY: 0,
      zoom: 1
    };

    function updateCrop() {
      if (!state.image) {
        return;
      }

      var imageWidth = state.image.naturalWidth || state.image.width;
      var imageHeight = state.image.naturalHeight || state.image.height;
      state.crop.width = state.baseCrop.width / state.zoom;
      state.crop.height = state.baseCrop.height / state.zoom;
      state.centerX = clamp(state.centerX, state.crop.width / 2, imageWidth - state.crop.width / 2);
      state.centerY = clamp(state.centerY, state.crop.height / 2, imageHeight - state.crop.height / 2);
      state.crop.x = state.centerX - state.crop.width / 2;
      state.crop.y = state.centerY - state.crop.height / 2;
    }

    function drawPreview() {
      if (!state.image) {
        return;
      }

      if (canvas.width !== spec.width || canvas.height !== spec.height) {
        canvas.width = spec.width;
        canvas.height = spec.height;
        context = canvas.getContext("2d");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        state.image,
        state.crop.x,
        state.crop.y,
        state.crop.width,
        state.crop.height,
        0,
        0,
        canvas.width,
        canvas.height
      );
    }

    function updateCropAndDraw(message) {
      updateCrop();
      drawPreview();
      if (message) {
        setStatus(status, message);
      }
    }

    function resetCrop() {
      var imageWidth = state.image.naturalWidth || state.image.width;
      var imageHeight = state.image.naturalHeight || state.image.height;
      var targetAspect = spec.width / spec.height;
      var sourceAspect = imageWidth / imageHeight;

      if (sourceAspect > targetAspect) {
        state.baseCrop.height = imageHeight;
        state.baseCrop.width = imageHeight * targetAspect;
      } else {
        state.baseCrop.width = imageWidth;
        state.baseCrop.height = imageWidth / targetAspect;
      }

      state.centerX = imageWidth / 2;
      state.centerY = imageHeight / 2;
      state.zoom = 1;
      zoomInput.value = "1";
      updateCropAndDraw();
    }

    function loadFile(file) {
      if (!file) {
        return;
      }

      if (file.type && file.type.indexOf("image/") !== 0) {
        setStatus(status, "Please choose an image file.", "error");
        return;
      }

      setStatus(status, "Loading image...");
      var nextUrl = URL.createObjectURL(file);
      var image = new Image();

      image.onload = function () {
        if (state.imageUrl) {
          URL.revokeObjectURL(state.imageUrl);
        }

        state.image = image;
        state.imageUrl = nextUrl;
        workspace.hidden = false;
        zoomInput.disabled = false;
        downloadButton.disabled = false;
        resetCrop();
        setStatus(status, "Image ready. Drag the preview or use Zoom to adjust the crop.");
        root.dispatchEvent(new CustomEvent("editorready"));
      };

      image.onerror = function () {
        URL.revokeObjectURL(nextUrl);
        setStatus(status, "This image could not be opened. Please try another file.", "error");
      };

      image.src = nextUrl;
    }

    fileInput.addEventListener("change", function () {
      loadFile(fileInput.files[0]);
    });

    zoomInput.addEventListener("input", function () {
      state.zoom = Number(zoomInput.value);
      updateCropAndDraw();
    });

    canvas.addEventListener("pointerdown", function (event) {
      if (!state.image) {
        return;
      }

      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      var rectangle = canvas.getBoundingClientRect();
      var drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        centerX: state.centerX,
        centerY: state.centerY,
        scaleX: state.crop.width / rectangle.width,
        scaleY: state.crop.height / rectangle.height
      };

      canvas.setPointerCapture(event.pointerId);

      function move(pointerEvent) {
        if (pointerEvent.pointerId !== drag.pointerId) {
          return;
        }

        state.centerX = drag.centerX - (pointerEvent.clientX - drag.startX) * drag.scaleX;
        state.centerY = drag.centerY - (pointerEvent.clientY - drag.startY) * drag.scaleY;
        updateCropAndDraw();
        pointerEvent.preventDefault();
      }

      function finish(pointerEvent) {
        if (pointerEvent.pointerId !== drag.pointerId) {
          return;
        }

        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", finish);
        canvas.removeEventListener("pointercancel", finish);
      }

      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", finish);
      canvas.addEventListener("pointercancel", finish);
      event.preventDefault();
    });

    downloadButton.addEventListener("click", function () {
      var idleLabel = downloadButton.getAttribute("data-idle-label") || downloadButton.textContent;
      setButtonBusy(downloadButton, true, "Preparing...");
      setStatus(status, "Compressing and preparing the JPEG...");

      renderJpeg(editor).then(function (result) {
        var fileName = outputFileName(kind, root);
        downloadBlob(result.blob, fileName);
        setButtonBusy(downloadButton, false, idleLabel);
        setStatus(
          status,
          "Saved " + fileName + " · " + result.width + "×" + result.height + " px · " + formatFileSize(result.blob.size),
          "success"
        );
      }).catch(function (error) {
        setButtonBusy(downloadButton, false, idleLabel);
        setStatus(status, error.message, "error");
      });
    });

    var editor = {
      root: root,
      kind: kind,
      spec: spec,
      state: state,
      render: function () {
        return renderJpeg(editor);
      }
    };

    editorByRoot.set(root, editor);
    return editor;
  }

  function initTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(document.querySelectorAll('[role="tabpanel"]'));

    function activate(tab) {
      tabs.forEach(function (item) {
        var selected = item === tab;
        item.setAttribute("aria-selected", selected ? "true" : "false");
        item.tabIndex = selected ? 0 : -1;
      });

      panels.forEach(function (panel) {
        panel.hidden = panel.id !== tab.getAttribute("aria-controls");
      });
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener("click", function () {
        activate(tab);
      });

      tab.addEventListener("keydown", function (event) {
        var nextIndex = index;

        if (event.key === "ArrowRight") {
          nextIndex = (index + 1) % tabs.length;
        } else if (event.key === "ArrowLeft") {
          nextIndex = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = tabs.length - 1;
        } else {
          return;
        }

        event.preventDefault();
        activate(tabs[nextIndex]);
        tabs[nextIndex].focus();
      });
    });
  }

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;

    for (var index = 0; index < bytes.length; index += 1) {
      crc ^= bytes[index];
      for (var bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
      }
    }

    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function writeUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function makeLocalHeader(nameBytes, data, crc, time, date) {
    var header = new Uint8Array(30 + nameBytes.length);
    var view = new DataView(header.buffer);
    writeUint32(view, 0, 0x04034B50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 0x0800);
    writeUint16(view, 8, 0);
    writeUint16(view, 10, time);
    writeUint16(view, 12, date);
    writeUint32(view, 14, crc);
    writeUint32(view, 18, data.length);
    writeUint32(view, 22, data.length);
    writeUint16(view, 26, nameBytes.length);
    writeUint16(view, 28, 0);
    header.set(nameBytes, 30);
    return header;
  }

  function makeCentralHeader(record, time, date) {
    var header = new Uint8Array(46 + record.nameBytes.length);
    var view = new DataView(header.buffer);
    writeUint32(view, 0, 0x02014B50);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 20);
    writeUint16(view, 8, 0x0800);
    writeUint16(view, 10, 0);
    writeUint16(view, 12, time);
    writeUint16(view, 14, date);
    writeUint32(view, 16, record.crc);
    writeUint32(view, 20, record.data.length);
    writeUint32(view, 24, record.data.length);
    writeUint16(view, 28, record.nameBytes.length);
    writeUint16(view, 30, 0);
    writeUint16(view, 32, 0);
    writeUint16(view, 34, 0);
    writeUint16(view, 36, 0);
    writeUint32(view, 38, 0);
    writeUint32(view, 42, record.offset);
    header.set(record.nameBytes, 46);
    return header;
  }

  function makeEndRecord(fileCount, centralSize, centralOffset) {
    var record = new Uint8Array(22);
    var view = new DataView(record.buffer);
    writeUint32(view, 0, 0x06054B50);
    writeUint16(view, 4, 0);
    writeUint16(view, 6, 0);
    writeUint16(view, 8, fileCount);
    writeUint16(view, 10, fileCount);
    writeUint32(view, 12, centralSize);
    writeUint32(view, 16, centralOffset);
    writeUint16(view, 20, 0);
    return record;
  }

  function dosDateTime() {
    var now = new Date();
    var year = Math.max(1980, now.getFullYear());
    var time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    var date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    return { time: time, date: date };
  }

  function createZip(files) {
    return Promise.all(files.map(function (file) {
      return file.blob.arrayBuffer().then(function (buffer) {
        return {
          name: file.name,
          data: new Uint8Array(buffer)
        };
      });
    })).then(function (preparedFiles) {
      var encoder = new TextEncoder();
      var stamp = dosDateTime();
      var parts = [];
      var centralRecords = [];
      var offset = 0;

      preparedFiles.forEach(function (file) {
        var nameBytes = encoder.encode(file.name);
        var crc = crc32(file.data);
        var localHeader = makeLocalHeader(nameBytes, file.data, crc, stamp.time, stamp.date);

        parts.push(localHeader, file.data);
        centralRecords.push({
          nameBytes: nameBytes,
          data: file.data,
          crc: crc,
          offset: offset
        });
        offset += localHeader.length + file.data.length;
      });

      var centralOffset = offset;
      var centralSize = 0;

      centralRecords.forEach(function (record) {
        var centralHeader = makeCentralHeader(record, stamp.time, stamp.date);
        parts.push(centralHeader);
        centralSize += centralHeader.length;
      });

      parts.push(makeEndRecord(centralRecords.length, centralSize, centralOffset));
      return new Blob(parts, { type: "application/zip" });
    });
  }

  function initCombinedZip() {
    var panel = document.getElementById("panel-both");
    var zipButton = panel.querySelector("[data-zip]");
    var zipStatus = panel.querySelector("[data-zip-status]");
    var editors = Array.prototype.slice.call(panel.querySelectorAll("[data-editor]")).map(function (root) {
      return editorByRoot.get(root);
    });
    var photoEditor = editors.filter(function (editor) {
      return editor.kind === "photo";
    })[0];
    var signatureEditor = editors.filter(function (editor) {
      return editor.kind === "signature";
    })[0];

    function updateReadyState() {
      var ready = Boolean(photoEditor.state.image && signatureEditor.state.image);
      zipButton.disabled = !ready;
      if (ready) {
        setStatus(zipStatus, "Both images are ready. Create the ZIP when the crops look correct.");
      } else {
        setStatus(zipStatus, "Waiting for both images.");
      }
    }

    photoEditor.root.addEventListener("editorready", updateReadyState);
    signatureEditor.root.addEventListener("editorready", updateReadyState);

    zipButton.addEventListener("click", function () {
      setButtonBusy(zipButton, true, "Preparing ZIP...");
      setStatus(zipStatus, "Preparing both JPEG files locally...");

      Promise.all([photoEditor.render(), signatureEditor.render()]).then(function (results) {
        return createZip([
          { name: outputFileName("photo", photoEditor.root), blob: results[0].blob },
          { name: outputFileName("signature", signatureEditor.root), blob: results[1].blob }
        ]).then(function (zipBlob) {
          var name = zipFileName(photoEditor.root);
          downloadBlob(zipBlob, name);
          setButtonBusy(zipButton, false, "Download ZIP");
          setStatus(zipStatus, "Saved " + name + " · " + formatFileSize(zipBlob.size), "success");
        });
      }).catch(function (error) {
        setButtonBusy(zipButton, false, "Download ZIP");
        setStatus(zipStatus, error.message, "error");
      });
    });
  }

  editorInstances = Array.prototype.slice.call(document.querySelectorAll("[data-editor]")).map(makeEditor);
  initTabs();
  initCombinedZip();
}());
