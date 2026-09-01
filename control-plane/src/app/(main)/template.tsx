import { BusinessFooter } from "@/components/BusinessFooter";

export default function MainTemplate({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      {children}
      <BusinessFooter />
    </>
  );
}
