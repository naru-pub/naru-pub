"use client";

import { useState, forwardRef, useImperativeHandle } from "react";
import Image from "next/image";

interface ImageViewerProps {
  src: string;
  alt: string;
  filename: string;
}

export interface ImageViewerRef {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  getZoom: () => number;
}

const ImageViewer = forwardRef<ImageViewerRef, ImageViewerProps>(
  function ImageViewer({ src, alt, filename }, ref) {
    const [zoom, setZoom] = useState(1);
    const [imageError, setImageError] = useState(false);

    const handleZoomIn = () => {
      setZoom((prev) => Math.min(prev * 1.2, 3));
    };

    const handleZoomOut = () => {
      setZoom((prev) => Math.max(prev / 1.2, 0.1));
    };

    const handleResetZoom = () => {
      setZoom(1);
    };

    useImperativeHandle(
      ref,
      () => ({
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        resetZoom: handleResetZoom,
        getZoom: () => zoom,
      }),
      [zoom],
    );

    if (imageError) {
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <div className="text-center">
            <div className="text-6xl mb-4">🖼️</div>
            <p>이미지를 불러올 수 없습니다</p>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full overflow-auto p-4 bg-muted">
        <div className="flex items-center justify-center min-h-full">
          <div
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "center center",
              transition: "transform 0.2s ease-out",
            }}
            className="max-w-full max-h-full"
          >
            {/* A file browser preview shows the user's own file as stored, at its
              real pixels, under manual zoom. next/image would rewrite it and
              would need remotePatterns for every user domain. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              onError={() => setImageError(true)}
              className="max-w-full max-h-full border border-border rounded"
              style={{
                display: "block",
                maxWidth: zoom === 1 ? "100%" : "none",
                maxHeight: zoom === 1 ? "100%" : "none",
                width: zoom === 1 ? "auto" : undefined,
                height: zoom === 1 ? "auto" : undefined,
              }}
            />
          </div>
        </div>
      </div>
    );
  },
);

export default ImageViewer;
