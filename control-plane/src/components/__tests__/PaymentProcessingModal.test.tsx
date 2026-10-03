import "@testing-library/jest-dom/jest-globals";
import { jest, beforeEach, afterEach, test, expect } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const router = { refresh: jest.fn(), replace: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => router }));
const { PaymentProcessingModal } =
  require("@/components/PaymentProcessingModal") as typeof import("@/components/PaymentProcessingModal");
const fetchMock = global.fetch as jest.Mock<typeof fetch>;
function response(state: string) {
  return {
    ok: true,
    json: async () => ({
      success: true,
      state,
      message:
        state === "completed"
          ? "결제가 완료되었습니다."
          : state === "failed"
            ? "결제가 완료되지 않았습니다."
            : "결제를 처리하고 있습니다.",
    }),
  } as Response;
}
beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  router.refresh.mockReset();
  router.replace.mockReset();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  jest.useRealTimers();
});
test("polls pending approval until completion, then refreshes history and stops", async () => {
  fetchMock
    .mockResolvedValueOnce(response("processing"))
    .mockResolvedValueOnce(response("completed"));
  render(<PaymentProcessingModal paymentId="payment" />);
  expect(screen.getByRole("dialog")).toHaveTextContent("결제 처리 중");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("dialog")).toHaveTextContent(
    "결제가 완료되었습니다.",
  );
  expect(router.refresh).toHaveBeenCalledTimes(1);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(
    fetchMock.mock.calls.every(([, options]) => options?.method !== "POST"),
  ).toBe(true);
});
test("temporary network failure stays processing and retries", async () => {
  fetchMock
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(response("completed"));
  render(<PaymentProcessingModal paymentId="payment" />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("연결을 확인"),
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("dialog")).toHaveTextContent("결제 완료");
});
test("failure is shown without reporting success", async () => {
  fetchMock.mockResolvedValue(response("failed"));
  render(<PaymentProcessingModal paymentId="payment" />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "결제가 완료되지 않았습니다.",
    ),
  );
  expect(screen.getByRole("dialog")).not.toHaveTextContent("결제 완료");
  expect(router.refresh).toHaveBeenCalledTimes(1);
});
test("closing pending processing stops polling and removes the modal URL", async () => {
  fetchMock.mockResolvedValue(response("processing"));
  render(<PaymentProcessingModal paymentId="payment" />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "닫고 결제 내역 보기" }));
  expect(router.replace).toHaveBeenCalledWith("/support/payments", {
    scroll: false,
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
