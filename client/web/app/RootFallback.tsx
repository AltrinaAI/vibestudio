import { Spinner } from "@/components/ui";

/** Shown during the initial lazy-route resolution on a cold start (no SSR/hydrate). */
export default function RootFallback() {
  return (
    <div className="grid h-screen place-items-center bg-app">
      <Spinner />
    </div>
  );
}
