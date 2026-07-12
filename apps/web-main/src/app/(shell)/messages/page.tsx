"use client";

import { Suspense } from "react";
import { MessagesView } from "@/components/messages/messages-view";

/** `/messages` 页。`useSearchParams`（`MessagesView` 内读取 `?id=`）需 Suspense 边界。 */
export default function MessagesPage() {
  return (
    <Suspense fallback={null}>
      <MessagesView />
    </Suspense>
  );
}
