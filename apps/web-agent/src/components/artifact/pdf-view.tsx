"use client";

import { useCallback, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// pdf.js worker：用本地打包的 worker（webpack 经 import.meta.url 产出 chunk），
// desktop(electron) 离线可用，不走 CDN。
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

/** 用 react-pdf(pdf.js)渲染 PDF blob：逐页竖排，宽度随容器自适应。 */
export function PdfView({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0);
  const [width, setWidth] = useState(0);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      setWidth(el.clientWidth);
    }
  }, []);

  return (
    <div
      ref={measure}
      className="flex flex-col items-center gap-3 bg-muted/30 p-3"
    >
      <Document
        file={url}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        loading={
          <div className="p-4 text-sm text-muted-foreground">加载中…</div>
        }
        error={
          <div className="p-4 text-sm text-muted-foreground">PDF 加载失败</div>
        }
      >
        {Array.from({ length: numPages }, (_, i) => i + 1).map((page) => (
          <Page
            key={page}
            pageNumber={page}
            width={width > 0 ? width - 24 : undefined}
            className="shadow-sm"
          />
        ))}
      </Document>
    </div>
  );
}
