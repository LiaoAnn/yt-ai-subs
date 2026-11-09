import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// A native <select> styled like shadcn/ui's Select trigger (after shadcn's NativeSelect).
// The extension's action popup uses this instead of Radix Select: Radix locks the page's
// scroll while open, which removes the popup's scrollbar and resizes the popup window,
// and Radix closes on any window resize (or blur), so the menu shut again at once.
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <div data-slot="native-select-wrapper" className="relative w-full">
      <select
        data-slot="native-select"
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent py-2 pr-9 pl-3 text-sm shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground opacity-50 select-none"
      />
    </div>
  );
}

function NativeSelectOption({ ...props }: React.ComponentProps<"option">) {
  return <option data-slot="native-select-option" {...props} />;
}

export { NativeSelect, NativeSelectOption };
