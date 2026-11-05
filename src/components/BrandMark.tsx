import Image from "next/image";
import LogoMark from "@/components/LogoMark";
import { brand } from "@/lib/tenant";

/**
 * The tenant's square mark: brand.logo.mark (a local file under /tenant/, copied there by the prebuild), else the
 * stock LogoMark. Decorative by default because the brand name sits beside it; pass `labelled` where it stands alone.
 */
export default function BrandMark({ size = 32, labelled = false }: { size?: number; labelled?: boolean }) {
  if (!brand.logo) return <LogoMark size={size} />;
  return (
    <Image
      src={brand.logo.mark}
      alt={labelled ? brand.logo.alt : ""}
      width={size}
      height={size}
      unoptimized
      className="shrink-0 rounded-md object-contain ring-1 ring-line"
      style={{ width: size, height: size }}
    />
  );
}
