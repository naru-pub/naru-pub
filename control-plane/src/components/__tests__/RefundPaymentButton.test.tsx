import "@testing-library/jest-dom/jest-globals";
import { jest, beforeEach, afterEach, test, expect } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const router = { refresh: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => router }));
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const { RefundPaymentButton } =
  require("@/components/RefundPaymentButton") as typeof import("@/components/RefundPaymentButton");
const { ConfirmProvider } =
  require("@/components/ui/confirm") as typeof import("@/components/ui/confirm");
const renderButton = (ui: React.ReactElement) =>
  render(<ConfirmProvider>{ui}</ConfirmProvider>);
const fetchMock = global.fetch as jest.Mock<typeof fetch>;
function response(state: string): Response {
  return {
    ok: true,
    json: async () => ({ success: true, result: { state } }),
  } as Response;
}
beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
});
test("acceptance shows pending until a later status confirms completion", async () => {
  fetchMock
    .mockResolvedValueOnce(response("pending"))
    .mockResolvedValueOnce(response("pending"))
    .mockResolvedValueOnce(response("completed"));
  renderButton(
    <RefundPaymentButton paymentId="payment" confirmMessage="refund?" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "환불" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("refund?");
  fireEvent.click(within(dialog).getByRole("button", { name: "환불" }));
  await waitFor(() =>
    expect(screen.getByRole("button")).toHaveTextContent("환불 처리 중"),
  );
  expect(screen.getByRole("button")).toBeDisabled();
  expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  expect(await screen.findByText("환불 완료")).toBeInTheDocument();
});
test("reopening a pending request recovers status and displays stopped work", async () => {
  fetchMock.mockResolvedValue(response("failed"));
  renderButton(
    <RefundPaymentButton
      paymentId="payment"
      confirmMessage="refund?"
      requested
    />,
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "환불 처리 확인 필요",
  );
  expect(fetchMock.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(
    true,
  );
});
test("a temporary status lookup failure leaves the request pending and retries", async () => {
  fetchMock
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response("completed"));
  renderButton(
    <RefundPaymentButton
      paymentId="payment"
      confirmMessage="refund?"
      requested
    />,
  );
  expect(screen.getByRole("button")).toBeDisabled();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  expect(await screen.findByText("환불 완료")).toBeInTheDocument();
});
test("dismissing the confirmation sends nothing", async () => {
  renderButton(
    <RefundPaymentButton paymentId="payment" confirmMessage="refund?" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "환불" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
