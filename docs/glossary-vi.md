# Bảng thuật ngữ tiếng Việt — Podium Studio (E6)

> Sinh tự động từ `src/i18n/locales/vi.ts` (nguồn Tiếng Việt) đối chiếu `en.ts` (bản dự phòng tiếng Anh) —
> mỗi khóa (key) hiển thị trên giao diện có đúng một dòng trong bảng này, nên **0 khoảng trống** giữa danh
> sách thuật ngữ của giao diện và bảng thuật ngữ (spec E6 AC3). Chạy lại phần sinh bảng bất cứ khi nào
> `vi.ts`/`en.ts` đổi để giữ bảng luôn khớp 100%.
>
> Cột **Khóa** là đường dẫn đến giá trị trong `vi.ts`/`en.ts` — dùng để đối chiếu (grep) khi rà soát.
> Cột **Tiếng Việt** là đúng nguyên văn hiển thị trong ứng dụng. Cột **Tiếng Anh** là bản đối chiếu (fallback).
> Cột **Giải thích** dùng tiếng Việt thuần, không viết tắt tiếng Anh (Pillar C).
>
> Phạm vi: khung ứng dụng + 7 thành phần đã bản địa hóa trong đợt này (DevicePanel, DoctorPanel, FlowList,
> RecordPanel, RunPanel, StepEditor, TextStepsPanel). Cú pháp DSL (bảng tra cú pháp trong tab Văn bản) giữ
> nguyên tiếng Anh có chủ đích — bí danh tiếng Việt cho DSL đang bị khóa bởi quyết định §7‑6 (chưa chốt).

Tổng số thuật ngữ: **291** (đối chiếu `vi.ts` = `en.ts` = 291 khóa, 0 lệch).

## Khung ứng dụng (App shell)

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `app.title` | Podium Studio | Podium Studio | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `app.connectedStatus` | Đã kết nối với trình chạy kiểm thử | Connected to test runner | Trạng thái kết nối giữa Podium Studio và bộ máy Podium (test runner) chạy nền — không phải kết quả qua/rớt của bài kiểm thử. |
| `app.disconnectedStatus` | Chưa kết nối với trình chạy kiểm thử | Not connected to the test runner | Trạng thái kết nối giữa Podium Studio và bộ máy Podium (test runner) chạy nền — không phải kết quả qua/rớt của bài kiểm thử. |
| `app.connectingStatus` | Đang kết nối… | Connecting… | Trạng thái kết nối giữa Podium Studio và bộ máy Podium (test runner) chạy nền — không phải kết quả qua/rớt của bài kiểm thử. |
| `app.localeToggleLabel` | Đổi ngôn ngữ | Switch language | Nút bật/tắt giữa hai ngôn ngữ hiển thị: Tiếng Việt và Tiếng Anh. |
| `app.discardConfirm` | Bỏ các thay đổi chưa lưu? Các chỉnh sửa kể từ lần lưu gần nhất sẽ bị mất. | Discard unsaved changes? Your edits since the last save will be lost. | Nội dung hộp thoại xác nhận trước khi thực hiện một thao tác khó hoàn tác. |

## Thanh tab (Steps / Text / Record / Run)

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `tabs.steps` | Bước | Steps | Tên của một tab trong thanh điều hướng chính (ba cách soạn bài kiểm thử + nút Chạy). |
| `tabs.text` | Văn bản | Text | Tên của một tab trong thanh điều hướng chính (ba cách soạn bài kiểm thử + nút Chạy). |
| `tabs.record` | Ghi lại | Record | Tên của một tab trong thanh điều hướng chính (ba cách soạn bài kiểm thử + nút Chạy). |
| `tabs.run` | Chạy | Run | Tên của một tab trong thanh điều hướng chính (ba cách soạn bài kiểm thử + nút Chạy). |
| `tabs.hint` | Ba cách soạn cùng một bài kiểm thử — Bước (trực quan), Văn bản (mỗi dòng một bước), Ghi lại (chạm vào điện thoại đang chạy). | Three ways to edit the same test — Steps (visual), Text (plain lines), Record (tap the phone). | Câu gợi ý hoặc hướng dẫn ngắn hiển thị cho người dùng. |

## Màn hình chào mừng

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `welcome.title` | Podium Studio hoạt động như thế nào | How Podium Studio works | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.lead` | Xây dựng một bài kiểm thử giao diện một lần, rồi phát lại trên trình mô phỏng và xem từng bước qua hay rớt — không cần viết code. | Build a UI test once, then replay it on a simulator and watch every step pass or fail — no coding. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.step1Title` | Soạn bài kiểm thử theo 3 cách. | Author your test three ways. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.step1Desc` | Bước — dựng từng hành động một cách trực quan. Văn bản — viết các dòng đơn giản như “tap Login”. Ghi lại — chạm vào điện thoại đang chạy, các bước sẽ tự ghi lại. | Steps — build it visually, one action at a time. Text — write plain lines like “tap Login”. Record — tap the live phone and it writes the steps for you. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.step2Title` | Chọn một trình mô phỏng. | Pick a simulator. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.step2Desc` | Chọn một iPhone mô phỏng ở bên trái rồi bấm Start để bài kiểm thử có nơi để chạy. | Choose an iPhone simulator on the left and press Start so the test has something to run on. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.step3Title` | Bấm Chạy. | Press Run. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.step3Desc` | Xem từng bước sáng xanh (qua) hoặc đỏ (rớt), kèm ảnh chụp màn hình cho mỗi bước. | Watch each step light up green (passed) or red (failed), with a screenshot for every step. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.cta` | Tạo bài kiểm thử đầu tiên | Create your first test | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |
| `welcome.ctaHint` | …hoặc mở một bài kiểm thử có sẵn ở bên trái. | …or open an existing test from the left. | Nội dung màn hình hướng dẫn hiển thị khi chưa mở bài kiểm thử nào. |

## Thuật ngữ dùng chung

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `common.stepsUnit` | bước | steps | Đơn vị đếm số bước trong một bài kiểm thử. |
| `common.showTechDetails` | Xem chi tiết kỹ thuật | Show technical details | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `common.hideTechDetails` | Ẩn chi tiết kỹ thuật | Hide technical details | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `common.confirmAria` | Xác nhận | Confirm | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `common.cancelAria` | Hủy | Cancel | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `common.closeAria` | Đóng | Close | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `common.stepStatus.pending` | chờ | pending | Trạng thái hiện tại của một bước khi bài kiểm thử đang chạy hoặc đã chạy xong. |
| `common.stepStatus.running` | đang chạy | running | Trạng thái hiện tại của một bước khi bài kiểm thử đang chạy hoặc đã chạy xong. |
| `common.stepStatus.passed` | qua | passed | Trạng thái hiện tại của một bước khi bài kiểm thử đang chạy hoặc đã chạy xong. |
| `common.stepStatus.failed` | rớt | failed | Trạng thái hiện tại của một bước khi bài kiểm thử đang chạy hoặc đã chạy xong. |
| `common.stepStatus.skipped` | bỏ qua | skipped | Trạng thái hiện tại của một bước khi bài kiểm thử đang chạy hoặc đã chạy xong. |

## Bảng Trình mô phỏng & Ứng dụng đã cài

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `devicePanel.title` | Trình mô phỏng | Simulators | Trình mô phỏng (Simulator) là một thiết bị iOS ảo chạy trên máy tính, dùng để kiểm thử không cần máy thật. |
| `devicePanel.refreshAria` | Làm mới danh sách trình mô phỏng | Refresh simulator list | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `devicePanel.refreshTitle` | Làm mới | Refresh | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `devicePanel.loading` | Đang tải trình mô phỏng… | Loading simulators… | Thông báo hiển thị trong lúc đang tải dữ liệu. |
| `devicePanel.empty` | Không tìm thấy trình mô phỏng nào | No simulators found | Thông báo hiển thị khi danh sách chưa có dữ liệu. |
| `devicePanel.startButton` | Bắt đầu | Start | Trình mô phỏng (Simulator) là một thiết bị iOS ảo chạy trên máy tính, dùng để kiểm thử không cần máy thật. |
| `devicePanel.startTitle` | Bắt đầu {{name}} | Start {{name}} | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `devicePanel.appsTitle` | Ứng dụng đã cài | Installed apps | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `devicePanel.appsRefreshAria` | Làm mới danh sách ứng dụng | Refresh installed apps | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `devicePanel.appsRefreshTitle` | Làm mới ứng dụng | Refresh apps | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `devicePanel.noActiveDevice` | Chưa chọn trình mô phỏng | No active simulator | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `devicePanel.noActiveDeviceHint` | Chọn một trình mô phỏng ở trên để xem ứng dụng của nó. | Select a simulator above to see its apps. | Câu gợi ý hoặc hướng dẫn ngắn hiển thị cho người dùng. |
| `devicePanel.startDeviceHint` | Bấm Bắt đầu trên “{{name}}” để xem và mở ứng dụng của nó. | Start “{{name}}” to list and launch its apps. | Trình mô phỏng (Simulator) là một thiết bị iOS ảo chạy trên máy tính, dùng để kiểm thử không cần máy thật. |
| `devicePanel.appsLoading` | Đang tải ứng dụng… | Loading apps… | Thông báo hiển thị trong lúc đang tải dữ liệu. |
| `devicePanel.noApps` | Không có ứng dụng người dùng nào được cài trên trình mô phỏng này. | No user apps installed on this simulator. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `devicePanel.useButton` | Dùng | Use | Nhãn của một nút bấm trên giao diện. |
| `devicePanel.useButtonTitle` | Dùng bundle id này | Use this bundle id | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `devicePanel.bundleIdLabel` | Bundle id để chạy | Bundle id to launch | Bundle id là tên định danh duy nhất của một ứng dụng trên iOS — bài kiểm thử dùng nó để biết chính xác ứng dụng nào cần chạy. |
| `devicePanel.bundleIdTip` | Bundle id là tên định danh riêng của ứng dụng mà iOS dùng để nhận diện nó — giống như một địa chỉ của ứng dụng. | A bundle id is the app's unique name that iOS uses to identify it — like an address for the app. | Bundle id là tên định danh duy nhất của một ứng dụng trên iOS — bài kiểm thử dùng nó để biết chính xác ứng dụng nào cần chạy. |
| `devicePanel.launchButton` | Mở ứng dụng | Launch | Nhãn của một nút bấm trên giao diện. |

## Bảng Kiểm tra môi trường (Environment Doctor)

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `doctorPanel.title` | Kiểm tra môi trường | Environment Doctor | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `doctorPanel.allGreenTitle` | Tất cả các mục đều đạt | All checks green | Trạng thái tổng quan của lượt kiểm tra môi trường (Environment Doctor): tất cả đạt, có mục chưa đạt, hoặc chưa chạy lần nào. |
| `doctorPanel.someRedTitle` | Có mục chưa đạt | Some checks red | Trạng thái tổng quan của lượt kiểm tra môi trường (Environment Doctor): tất cả đạt, có mục chưa đạt, hoặc chưa chạy lần nào. |
| `doctorPanel.notYetRunTitle` | Chưa chạy kiểm tra | Not yet run | Trạng thái tổng quan của lượt kiểm tra môi trường (Environment Doctor): tất cả đạt, có mục chưa đạt, hoặc chưa chạy lần nào. |
| `doctorPanel.rerunAria` | Chạy lại kiểm tra môi trường | Re-run Environment Doctor | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `doctorPanel.rerunTitle` | Chạy lại | Run again | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `doctorPanel.summary` | {{passed}}/{{total}} mục đạt · {{ms}}ms | {{passed}}/{{total}} checks passed · {{ms}}ms | Số liệu tổng hợp (đếm số mục, tỉ lệ đạt, thời gian) hiển thị trên giao diện. |

## Danh sách bài kiểm thử

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `flowList.title` | Bài kiểm thử | Flows | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `flowList.refreshAria` | Làm mới danh sách bài kiểm thử | Refresh flow list | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `flowList.refreshTitle` | Làm mới | Refresh | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `flowList.newButton` | Mới | New | Nhãn của một nút bấm trên giao diện. |
| `flowList.loading` | Đang tải bài kiểm thử… | Loading flows… | Thông báo hiển thị trong lúc đang tải dữ liệu. |
| `flowList.empty` | Chưa có bài kiểm thử nào | No flows yet | Thông báo hiển thị khi danh sách chưa có dữ liệu. |
| `flowList.emptyHint` | Tạo một bài để bắt đầu soạn các bước. | Create one to start authoring steps. | Câu gợi ý hoặc hướng dẫn ngắn hiển thị cho người dùng. |
| `flowList.openBadge` | Đang mở | Open | Nhãn trạng thái ngắn hiển thị trên giao diện. |

## Soạn bước bằng văn bản

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `textSteps.title` | Viết các bước bằng văn bản | Write steps as text | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `textSteps.subtitle` | Mỗi dòng là một bước, viết bằng câu đơn giản. Không dùng AI — cùng một đoạn văn bản luôn phân tích ra cùng các bước. | One line = one step, in plain English. No AI — the same text always parses to the same steps. | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `textSteps.reloadButton` | Tải lại từ các bước hiện có | Reload from current steps | Nhãn của một nút bấm trên giao diện. |
| `textSteps.textareaAria` | Các bước của bài kiểm thử dạng văn bản thuần | Flow steps as plain text | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `textSteps.parsedCountLabel` | {{n}} bước đã phân tích | {{n}} steps parsed | Nhãn của một trường nhập liệu hoặc mục trên giao diện. |
| `textSteps.issuesCountLabel` | {{n}} vấn đề | {{n}} issue(s) | Nhãn của một trường nhập liệu hoặc mục trên giao diện. |
| `textSteps.emptyParsed` | Chưa có gì được phân tích — hãy viết một bước ở trên, mỗi dòng một bước. | Nothing parsed yet — write a step above, one per line. | Thông báo hiển thị khi danh sách chưa có dữ liệu. |
| `textSteps.issueLinePrefix` | Dòng {{line}} | Line {{line}} | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `textSteps.appendButton` | Thêm vào cuối bài kiểm thử | Add to end of test | Nhãn của một nút bấm trên giao diện. |
| `textSteps.appendTitleDisabled` | Sửa các vấn đề (hoặc viết ít nhất một bước) trước | Fix the issues (or write at least one step) first | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `textSteps.appendTitleEnabled` | Thêm các bước này vào cuối bài kiểm thử | Add these to the end of the test | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `textSteps.replaceButton` | Thay thế tất cả các bước | Replace all steps | Nhãn của một nút bấm trên giao diện. |
| `textSteps.replaceTitleEnabled` | Thay thế toàn bộ các bước trong bài kiểm thử | Replace every step in the test | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `textSteps.replaceConfirm` | Thao tác này sẽ thay {{oldCount}} bước hiện có trong bài kiểm thử bằng {{newCount}} bước ở trên.{{warn}} | This replaces all {{oldCount}} steps in the test with the {{newCount}} above.{{warn}} | Nội dung hộp thoại xác nhận trước khi thực hiện một thao tác khó hoàn tác. |
| `textSteps.replaceConfirmWarn` |  Các thay đổi chưa lưu sẽ bị mất. |  Your unsaved changes will be lost. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `textSteps.emptySteps` | Bài kiểm thử này chưa có bước nào | This test has no steps yet | Thông báo hiển thị khi danh sách chưa có dữ liệu. |
| `textSteps.emptyStepsHint` | Viết các bước ở trên, rồi bấm “Thêm vào cuối bài kiểm thử”. | Write steps above, then press “Add to end of test”. | Câu gợi ý hoặc hướng dẫn ngắn hiển thị cho người dùng. |
| `textSteps.cheatSheetTitle` | Bảng tra cú pháp | Grammar cheat sheet | Bảng cú pháp DSL — các mẫu câu tiếng Anh cố định để viết bước kiểm thử dưới dạng văn bản (không dùng AI). |
| `textSteps.cheatSheetNoteA` | tùy chọn hậu tố | optional | Bảng cú pháp DSL — các mẫu câu tiếng Anh cố định để viết bước kiểm thử dưới dạng văn bản (không dùng AI). |
| `textSteps.cheatSheetNoteB` | ở cuối bất kỳ dòng nào · các dòng bắt đầu bằng | suffix on any line · lines starting with | Bảng cú pháp DSL — các mẫu câu tiếng Anh cố định để viết bước kiểm thử dưới dạng văn bản (không dùng AI). |
| `textSteps.cheatSheetNoteC` | là chú thích | are comments | Bảng cú pháp DSL — các mẫu câu tiếng Anh cố định để viết bước kiểm thử dưới dạng văn bản (không dùng AI). |

## Bảng Chạy & Dòng thời gian

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `runPanel.title` | Chạy | Run | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `runPanel.stopButton` | Dừng | Stop | Nhãn của một nút bấm trên giao diện. |
| `runPanel.stoppingButton` | Đang dừng… | Stopping… | Nhãn của một nút bấm trên giao diện. |
| `runPanel.runButton` | Chạy | Run | Nhãn của một nút bấm trên giao diện. |
| `runPanel.hintPickSimulator` | Chọn một trình mô phỏng đã khởi động ở bên trái trước. | Pick a started simulator on the left first. | Trình mô phỏng (Simulator) là một thiết bị iOS ảo chạy trên máy tính, dùng để kiểm thử không cần máy thật. |
| `runPanel.hintNotStarted` | Trình mô phỏng đã chọn chưa được khởi động — bấm Bắt đầu ở bên trái. | The selected simulator isn’t started yet — press Start on the left. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.hintNoTest` | Chưa mở bài kiểm thử nào. | No test open. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.hintFinishSteps` | Hoàn tất các bước (xem tab Bước) trước khi chạy. | Finish filling in the steps (see the Steps tab) before running. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.appNotInstalledPrefix` | Ứng dụng | The app | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.appNotInstalledSuffix` | chưa được cài trên trình mô phỏng này. Hãy cài đặt, hoặc chọn một trình mô phỏng đã có sẵn ứng dụng. | isn’t installed on this simulator. Install it, or pick a simulator that already has it. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.passedLabel` | QUA | PASSED | Nhãn của một trường nhập liệu hoặc mục trên giao diện. |
| `runPanel.failedLabel` | RỚT | FAILED | Nhãn của một trường nhập liệu hoặc mục trên giao diện. |
| `runPanel.statsLabel` | {{passed}}/{{total}} qua · {{seconds}}s | {{passed}}/{{total}} passed · {{seconds}}s | Nhãn của một trường nhập liệu hoặc mục trên giao diện. |
| `runPanel.timelineTitle` | Dòng thời gian các bước | Step timeline | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `runPanel.noRun` | Chưa chạy lần nào | No run yet | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.noRunHint` | Bấm Chạy để phát lại bài kiểm thử đang mở và xem trực tiếp. | Press Run to replay the open flow and watch it live. | Câu gợi ý hoặc hướng dẫn ngắn hiển thị cho người dùng. |
| `runPanel.enlargeAria` | Phóng to ảnh chụp màn hình | Enlarge screenshot | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `runPanel.noScreenshotAria` | Chưa có ảnh chụp màn hình | No screenshot yet | Chụp lại ảnh màn hình hiện tại để làm bằng chứng cho bước kiểm thử. |
| `runPanel.showLog` | Xem nhật ký kỹ thuật ({{n}}) | Show technical log ({{n}}) | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.hideLog` | Ẩn nhật ký kỹ thuật | Hide technical log | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `runPanel.evidenceTitle` | Bằng chứng | Evidence | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |

## Chế độ Ghi lại (Record)

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `recordPanel.hintStartSimulator` | Khởi động một trình mô phỏng ở bên trái, rồi quay lại đây để ghi lại bằng cách chạm vào điện thoại. | Start a simulator on the left, then come back here to record by tapping the phone. | Trình mô phỏng (Simulator) là một thiết bị iOS ảo chạy trên máy tính, dùng để kiểm thử không cần máy thật. |
| `recordPanel.placeholder.type` | Văn bản cần nhập… | Text to type… | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.placeholder.waitFor` | Văn bản cần chờ xuất hiện… | Text to wait for… | Chờ cho đến khi một đoạn văn bản xuất hiện trên màn hình, trong một khoảng thời gian tối đa. |
| `recordPanel.placeholder.waitForNotVisible` | Văn bản cần biến mất… | Text that should disappear… | Chờ cho đến khi một đoạn văn bản biến mất khỏi màn hình. |
| `recordPanel.placeholder.assertVisible` | Văn bản cần hiển thị… | Text that should be visible… | Kiểm tra rằng một đoạn văn bản có xuất hiện trên màn hình — đây là bước xác nhận kết quả. |
| `recordPanel.placeholder.assertNotVisible` | Văn bản KHÔNG được hiển thị… | Text that should NOT be visible… | Kiểm tra rằng một đoạn văn bản KHÔNG xuất hiện trên màn hình. |
| `recordPanel.placeholder.tapIfVisible` | Chạm vào văn bản này nếu nó hiển thị… | Tap this text if it's visible… | Chạm vào một phần tử CHỈ KHI nó đang hiển thị — dùng để xử lý các popup không chắc chắn có xuất hiện. |
| `recordPanel.placeholder.scrollUntilVisible` | Cuộn cho đến khi văn bản này xuất hiện… | Scroll until this text appears… | Cuộn màn hình liên tục cho đến khi một đoạn văn bản xuất hiện. |
| `recordPanel.placeholder.openLink` | https://... hoặc myapp://... | https://... or myapp://... | Mở một đường dẫn (URL) hoặc deep link trên thiết bị. |
| `recordPanel.placeholder.copyText` | Văn bản của phần tử cần sao chép… | Text of the element to copy… | Sao chép văn bản của một phần tử để dùng lại ở bước sau. |
| `recordPanel.placeholder.deleteText` | Số ký tự, ví dụ 3 | Number of characters, e.g. 3 | Xóa một số ký tự khỏi ô nhập đang được chọn. |
| `recordPanel.placeholder.raw` | - tapOn: "..." | - tapOn: "..." | Lệnh kiểm thử viết trực tiếp (Maestro) — một cửa ngách nâng cao dành cho kỹ sư. |
| `recordPanel.flowAppLabel` | Ứng dụng của bài kiểm thử | Flow app | Ứng dụng mục tiêu mà bài kiểm thử này sẽ chạy trên đó. |
| `recordPanel.launchButton` | Mở ứng dụng | Launch app | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.launchTitleNoBundle` | Đặt bundle id trong tab Bước trước | Set a bundle id in the Steps tab first | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.launchTitleRelaunch` | Mở lại ứng dụng của bài kiểm thử | Relaunch the flow's app | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.hintNoBundle` | Bài kiểm thử này chưa có bundle id — các thao tác cử chỉ và phím cần một ứng dụng đang mở. Đặt một bundle id trong tab Bước. | This flow has no bundle id — gesture and key actions need a foreground app. Set one in the Steps tab. | idb — công cụ giao tiếp với thiết bị/trình mô phỏng iOS mà Podium dùng bên dưới. |
| `recordPanel.liveMirror` | Màn hình trực tiếp | Live mirror | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.recordingBadge` | đang ghi… | recording… | Nhãn trạng thái ngắn hiển thị trên giao diện. |
| `recordPanel.refreshScreenButton` | Làm mới màn hình | Refresh screen | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.mirrorCaption` | Chạm vào màn hình điện thoại để ghi lại một thao tác chạm tại đó. Mỗi hành động bạn làm sẽ được thêm thành một bước. | Click the phone screen to record a tap there. Each action you do is added as a step. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.capturingScreen` | Đang chụp màn hình… | Capturing screen… | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.noScreenCaptured` | Chưa có ảnh màn hình nào | No screen captured yet | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.nextClickHint` | Lần chạm tiếp theo trên màn hình sẽ ghi lại một {{gesture}}. | Next mirror click records a {{gesture}}. | Câu gợi ý hoặc hướng dẫn ngắn hiển thị cho người dùng. |
| `recordPanel.gestureDoubleTap` | chạm đúp | double tap | Chạm hai lần liên tiếp vào cùng một vị trí trên màn hình. |
| `recordPanel.gestureLongPress` | chạm giữ | long press | Chạm và giữ tại một vị trí trên màn hình trong một khoảng thời gian. |
| `recordPanel.stepRecorded` | Đã ghi lại bước. | Step recorded. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.stepNotAddedNote` | Bước này chưa được thêm — không có gì để hoàn tác. | This step wasn't added — nothing to undo. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.actionsColTitle` | Hành động | Actions | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `recordPanel.sectionTapMode` | Chế độ chạm | Tap mode | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.doubleTapButton` | Chạm đúp | Double tap | Chạm hai lần liên tiếp vào cùng một vị trí trên màn hình. |
| `recordPanel.longPressButton` | Chạm giữ | Long press | Chạm và giữ tại một vị trí trên màn hình trong một khoảng thời gian. |
| `recordPanel.tapIfVisibleButton` | Chạm nếu hiển thị… | Tap if visible… | Chạm vào một phần tử CHỈ KHI nó đang hiển thị — dùng để xử lý các popup không chắc chắn có xuất hiện. |
| `recordPanel.sectionText` | Văn bản | Text | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.typeButton` | Nhập… | Type… | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.clearTextButton` | Xóa văn bản | Clear text | Xóa toàn bộ văn bản đang có trong ô nhập đang được chọn. |
| `recordPanel.deleteButton` | Xóa… | Delete… | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.pasteButton` | Dán | Paste | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.copyButton` | Sao chép… | Copy… | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.hideKeyboardButton` | Ẩn bàn phím | Hide keyboard | Ẩn bàn phím ảo đang hiển thị trên màn hình. |
| `recordPanel.sectionNavigate` | Điều hướng | Navigate | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.sendKeyAria` | Phím để gửi | Key to send | Gửi một phím hệ thống (ví dụ Enter, Back) đến thiết bị. |
| `recordPanel.sendKeyButton` | Gửi phím | Send key | Gửi một phím hệ thống (ví dụ Enter, Back) đến thiết bị. |
| `recordPanel.backButton` | Quay lại | Back | Điều hướng quay lại màn hình trước đó. |
| `recordPanel.swipeLabel` | Vuốt | Swipe | Vuốt màn hình theo một hướng (lên/xuống/trái/phải). |
| `recordPanel.scrollLabel` | Cuộn | Scroll | Cuộn màn hình theo một hướng để xem thêm nội dung. |
| `recordPanel.upButton` | Lên | Up | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.downButton` | Xuống | Down | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.leftButton` | Trái | Left | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.rightButton` | Phải | Right | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.scrollToButton` | Cuộn đến… | Scroll to… | Cuộn màn hình liên tục cho đến khi một đoạn văn bản xuất hiện. |
| `recordPanel.sectionWaitAssert` | Chờ & kiểm tra | Wait & assert | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.waitForButton` | Chờ… | Wait for… | Chờ cho đến khi một đoạn văn bản xuất hiện trên màn hình, trong một khoảng thời gian tối đa. |
| `recordPanel.waitGoneButton` | Chờ biến mất… | Wait gone… | Chờ cho đến khi một đoạn văn bản xuất hiện trên màn hình, trong một khoảng thời gian tối đa. |
| `recordPanel.assertButton` | Kiểm tra… | Assert… | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.assertNotButton` | Kiểm tra không có… | Assert not… | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.sectionAppAdvanced` | Ứng dụng & nâng cao | App & advanced | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `recordPanel.openLinkButton` | Mở liên kết… | Open link… | Mở một đường dẫn (URL) hoặc deep link trên thiết bị. |
| `recordPanel.screenshotButton` | Chụp màn hình | Screenshot | Chụp lại ảnh màn hình hiện tại để làm bằng chứng cho bước kiểm thử. |
| `recordPanel.rawButton` | Thô… | Raw… | Cách viết lệnh Maestro trực tiếp — một cửa ngách dành cho kỹ sư, hầu hết bài kiểm thử không cần dùng. |
| `recordPanel.recordedStepsTitle` | Các bước đã ghi ({{n}}) | Recorded steps ({{n}}) | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `recordPanel.removeLastButton` | Xóa bước cuối | Remove last | Nhãn của một nút bấm trên giao diện. |
| `recordPanel.emptyStepsTitle` | Chưa ghi bước nào | No steps recorded yet | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `recordPanel.emptyStepsHint` | Chạm vào màn hình hoặc dùng một nút hành động để bắt đầu. | Click the mirror or use an action button to start. | Câu gợi ý hoặc hướng dẫn ngắn hiển thị cho người dùng. |
| `recordPanel.deleteStepAria` | Xóa bước {{n}} | Delete step {{n}} | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `recordPanel.deleteStepTitle` | Xóa bước này | Delete this step | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |

## Trình soạn bước (Step Editor)

| Khóa | Tiếng Việt | Tiếng Anh | Giải thích |
|---|---|---|---|
| `stepEditor.actionLabel.tap` | Chạm vào vị trí chính xác (nâng cao) | Tap exact spot (advanced) | Chạm vào một vị trí hoặc một phần tử có văn bản cụ thể trên màn hình. |
| `stepEditor.actionLabel.tapText` | Chạm theo văn bản | Tap by text | Chạm vào một vị trí hoặc một phần tử có văn bản cụ thể trên màn hình. |
| `stepEditor.actionLabel.doubleTap` | Chạm đúp | Double tap | Chạm hai lần liên tiếp vào cùng một vị trí trên màn hình. |
| `stepEditor.actionLabel.longPress` | Chạm giữ | Long press | Chạm và giữ tại một vị trí trên màn hình trong một khoảng thời gian. |
| `stepEditor.actionLabel.tapIfVisible` | Chạm nếu hiển thị | Tap if visible | Chạm vào một phần tử CHỈ KHI nó đang hiển thị — dùng để xử lý các popup không chắc chắn có xuất hiện. |
| `stepEditor.actionLabel.type` | Nhập | Type | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.actionLabel.clearText` | Xóa văn bản | Clear text | Xóa toàn bộ văn bản đang có trong ô nhập đang được chọn. |
| `stepEditor.actionLabel.deleteText` | Xóa ký tự | Delete chars | Xóa một số ký tự khỏi ô nhập đang được chọn. |
| `stepEditor.actionLabel.pasteText` | Dán | Paste | Dán nội dung clipboard vào ô nhập đang được chọn. |
| `stepEditor.actionLabel.copyText` | Sao chép văn bản | Copy text | Sao chép văn bản của một phần tử để dùng lại ở bước sau. |
| `stepEditor.actionLabel.hideKeyboard` | Ẩn bàn phím | Hide keyboard | Ẩn bàn phím ảo đang hiển thị trên màn hình. |
| `stepEditor.actionLabel.key` | Phím | Key | Gửi một phím hệ thống (ví dụ Enter, Back) đến thiết bị. |
| `stepEditor.actionLabel.swipe` | Vuốt | Swipe | Vuốt màn hình theo một hướng (lên/xuống/trái/phải). |
| `stepEditor.actionLabel.scroll` | Cuộn | Scroll | Cuộn màn hình theo một hướng để xem thêm nội dung. |
| `stepEditor.actionLabel.scrollUntilVisible` | Cuộn đến | Scroll to | Cuộn màn hình liên tục cho đến khi một đoạn văn bản xuất hiện. |
| `stepEditor.actionLabel.back` | Quay lại | Back | Điều hướng quay lại màn hình trước đó. |
| `stepEditor.actionLabel.waitFor` | Chờ xuất hiện | Wait for | Chờ cho đến khi một đoạn văn bản xuất hiện trên màn hình, trong một khoảng thời gian tối đa. |
| `stepEditor.actionLabel.waitForNotVisible` | Chờ đến khi biến mất | Wait until gone | Chờ cho đến khi một đoạn văn bản biến mất khỏi màn hình. |
| `stepEditor.actionLabel.waitMs` | Chờ | Wait | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.actionLabel.assertVisible` | Kiểm tra | Assert | Kiểm tra rằng một đoạn văn bản có xuất hiện trên màn hình — đây là bước xác nhận kết quả. |
| `stepEditor.actionLabel.assertNotVisible` | Kiểm tra không hiển thị | Assert not visible | Kiểm tra rằng một đoạn văn bản KHÔNG xuất hiện trên màn hình. |
| `stepEditor.actionLabel.screenshot` | Chụp màn hình | Screenshot | Chụp lại ảnh màn hình hiện tại để làm bằng chứng cho bước kiểm thử. |
| `stepEditor.actionLabel.openLink` | Mở liên kết | Open link | Mở một đường dẫn (URL) hoặc deep link trên thiết bị. |
| `stepEditor.actionLabel.launchApp` | Mở ứng dụng | Launch app | Mở (khởi chạy) một ứng dụng trên thiết bị. |
| `stepEditor.actionLabel.stopApp` | Dừng ứng dụng | Stop app | Dừng một ứng dụng đang chạy trên thiết bị. |
| `stepEditor.actionLabel.raw` | Maestro thô | Raw Maestro | Cách viết lệnh Maestro trực tiếp — một cửa ngách dành cho kỹ sư, hầu hết bài kiểm thử không cần dùng. |
| `stepEditor.groupLabel.tap` | Chạm | Tap | Chạm vào một vị trí hoặc một phần tử có văn bản cụ thể trên màn hình. |
| `stepEditor.groupLabel.typeText` | Nhập văn bản | Type text | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.groupLabel.checkScreen` | Kiểm tra màn hình | Check the screen | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.groupLabel.wait` | Chờ | Wait | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.groupLabel.moveAround` | Di chuyển | Move around | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.groupLabel.appScreenshots` | Ứng dụng & ảnh chụp màn hình | App & screenshots | Chụp lại ảnh màn hình hiện tại để làm bằng chứng cho bước kiểm thử. |
| `stepEditor.groupLabel.advanced` | Nâng cao | Advanced | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.flowNameAria` | Tên bài kiểm thử | Flow name | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `stepEditor.flowNamePlaceholder` | Bài kiểm thử chưa đặt tên | Untitled flow | Văn bản mẫu hiển thị mờ trong ô nhập khi chưa có nội dung. |
| `stepEditor.bundleIdLabel` | Ứng dụng cần kiểm thử (bundle id) | App to test (bundle id) | Bundle id là tên định danh duy nhất của một ứng dụng trên iOS — bài kiểm thử dùng nó để biết chính xác ứng dụng nào cần chạy. |
| `stepEditor.bundleIdTip` | Bundle id là tên định danh riêng của ứng dụng mà iOS dùng để nhận diện nó — bài kiểm thử chạy trên ứng dụng này. | A bundle id is the app's unique name that iOS uses to identify it — the test runs against this app. | Bundle id là tên định danh duy nhất của một ứng dụng trên iOS — bài kiểm thử dùng nó để biết chính xác ứng dụng nào cần chạy. |
| `stepEditor.exportMenuTitle` | Xuất sang Maestro | Export to Maestro | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.exportMenuDesc` | Chuyển file kiểm thử cho kỹ sư. | Hand the test file to an engineer. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.exportDisabledTitle` | Hoàn tất các bước trước | Finish the steps first | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.saveButtonSaved` | Đã lưu | Saved | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.saveButtonSaveChanges` | Lưu thay đổi | Save changes | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.saveButtonSave` | Lưu | Save | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.saveDisabledTitle` | Hoàn tất các bước trước khi lưu | Finish the steps before saving | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.customLabelField` | Nhãn tùy chỉnh (không bắt buộc) | Custom label (optional) | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.qaNoteField` | Ghi chú QA (không bắt buộc) | QA note (optional) | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.qaNotePlaceholder` | Vì sao bước này quan trọng… | Why this step matters… | Văn bản mẫu hiển thị mờ trong ô nhập khi chưa có nội dung. |
| `stepEditor.moveUpAria` | Di chuyển bước lên | Move step up | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `stepEditor.moveUpTitle` | Lên | Move up | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.moveDownAria` | Di chuyển bước xuống | Move step down | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `stepEditor.moveDownTitle` | Xuống | Move down | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.duplicateAria` | Nhân đôi bước | Duplicate step | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `stepEditor.duplicateTitle` | Nhân đôi | Duplicate | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.enableAria` | Bật bước | Enable step | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `stepEditor.disableAria` | Tắt bước | Disable step | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `stepEditor.enableTitle` | Bật | Enable | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.disableTitle` | Tắt | Disable | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.deleteAria` | Xóa bước | Delete step | Mô tả trợ năng (đọc màn hình) cho một nút/điều khiển — không hiển thị trực tiếp trên giao diện. |
| `stepEditor.deleteTitle` | Xóa | Delete | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.deleteMinStepsTitle` | Bài kiểm thử cần ít nhất một bước | A flow needs at least one step | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.deleteConfirm` | Xóa bước {{n}}? | Delete step {{n}}? | Nội dung hộp thoại xác nhận trước khi thực hiện một thao tác khó hoàn tác. |
| `stepEditor.addStepButton` | Thêm bước | Add step | Nhãn của một nút bấm trên giao diện. |
| `stepEditor.exportModalTitle` | Xuất cho lập trình viên — chuyển file này cho kỹ sư | Developer export — hand this file to an engineer | Tiêu đề của một khu vực, hộp thoại, hoặc trạng thái trên giao diện. |
| `stepEditor.field.x` | X | X | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.y` | Y | Y | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.elementText` | Văn bản của phần tử | Element text | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.accessibilityId` | Accessibility id | Accessibility id | Một tên ẩn do lập trình viên đặt cho một phần tử giao diện, giúp bài kiểm thử tìm đúng phần tử đó dù văn bản hiển thị có thay đổi. |
| `stepEditor.field.index` | Vị trí (index) | Index | Số thứ tự dùng để chọn đúng phần tử khi có nhiều phần tử giống nhau trên màn hình — 0 là phần tử đầu tiên. |
| `stepEditor.field.textToType` | Văn bản cần nhập | Text to type | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.pressEnterAfter` | Nhấn Enter sau khi nhập | Press Enter after | Tự động nhấn phím Enter ngay sau khi nhập xong văn bản. |
| `stepEditor.field.key` | Phím | Key | Gửi một phím hệ thống (ví dụ Enter, Back) đến thiết bị. |
| `stepEditor.field.direction` | Hướng | Direction | Hướng (hoặc tọa độ tùy chỉnh) của một thao tác vuốt hoặc cuộn màn hình. |
| `stepEditor.field.startX` | X bắt đầu | Start X | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.startY` | Y bắt đầu | Start Y | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.endX` | X kết thúc | End X | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.endY` | Y kết thúc | End Y | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.waitForText` | Văn bản cần chờ | Wait for text | Chờ cho đến khi một đoạn văn bản xuất hiện trên màn hình, trong một khoảng thời gian tối đa. |
| `stepEditor.field.timeoutSeconds` | Thời gian chờ tối đa (giây) | Timeout (seconds) | Thời gian tối đa hệ thống chờ trước khi coi bước đó là thất bại. |
| `stepEditor.field.waitSeconds` | Chờ (giây) | Wait (seconds) | Thời gian tối đa hệ thống chờ trước khi coi bước đó là thất bại. |
| `stepEditor.field.noFieldsScreenshot` | Không có trường nào — chụp lại màn hình hiện tại. | No fields — captures the current screen. | Chụp lại ảnh màn hình hiện tại để làm bằng chứng cho bước kiểm thử. |
| `stepEditor.field.assertVisibleText` | Văn bản cần kiểm tra hiển thị | Assert visible text | Kiểm tra rằng một đoạn văn bản có xuất hiện trên màn hình — đây là bước xác nhận kết quả. |
| `stepEditor.field.tapIfVisibleText` | Chạm vào văn bản này nếu nó hiển thị | Tap if this text is visible | Chạm vào một phần tử CHỈ KHI nó đang hiển thị — dùng để xử lý các popup không chắc chắn có xuất hiện. |
| `stepEditor.field.noFieldsClearText` | Không có trường nào — xóa toàn bộ văn bản trong ô đang chọn. | No fields — erases all text in the focused field. | Xóa toàn bộ văn bản đang có trong ô nhập đang được chọn. |
| `stepEditor.field.charsToDelete` | Số ký tự cần xóa | Characters to delete | Xóa một số ký tự khỏi ô nhập đang được chọn. |
| `stepEditor.field.noFieldsHideKeyboard` | Không có trường nào — ẩn bàn phím trên màn hình. | No fields — dismisses the on-screen keyboard. | Ẩn bàn phím ảo đang hiển thị trên màn hình. |
| `stepEditor.field.scrollUntilVisibleText` | Cuộn đến khi văn bản này hiển thị | Scroll until this text is visible | Cuộn màn hình liên tục cho đến khi một đoạn văn bản xuất hiện. |
| `stepEditor.field.noFieldsBack` | Không có trường nào — điều hướng quay lại. | No fields — navigates back. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.assertNotVisibleText` | Văn bản KHÔNG được hiển thị | Assert NOT visible text | Kiểm tra rằng một đoạn văn bản KHÔNG xuất hiện trên màn hình. |
| `stepEditor.field.waitUntilGoneText` | Chờ đến khi văn bản này biến mất | Wait until this text disappears | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.urlDeepLink` | URL / deep link | URL / deep link | Đường dẫn (URL) hoặc deep link để mở thẳng một màn hình cụ thể trong ứng dụng. |
| `stepEditor.field.bundleId` | Bundle id | Bundle id | Bundle id là tên định danh duy nhất của một ứng dụng trên iOS — bài kiểm thử dùng nó để biết chính xác ứng dụng nào cần chạy. |
| `stepEditor.field.copyTextFrom` | Sao chép văn bản từ phần tử | Copy text from element | Sao chép văn bản của một phần tử để dùng lại ở bước sau. |
| `stepEditor.field.noFieldsPaste` | Không có trường nào — dán nội dung clipboard vào ô đang chọn. | No fields — pastes the clipboard into the focused field. | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.field.rawMaestro` | Lệnh Maestro thô | Raw Maestro command(s) | Cách viết lệnh Maestro trực tiếp — một cửa ngách dành cho kỹ sư, hầu hết bài kiểm thử không cần dùng. |
| `stepEditor.ph.egLogin` | vd. Login | e.g. Login | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.optional` | không bắt buộc | optional | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.egEmail` | vd. jane@example.com | e.g. jane@example.com | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.egWelcome` | vd. Welcome | e.g. Welcome | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.egAllow` | vd. Allow | e.g. Allow | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.egTerms` | vd. Terms & Conditions | e.g. Terms & Conditions | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.egError` | vd. Error | e.g. Error | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.egLoading` | vd. Loading… | e.g. Loading… | Thông báo hiển thị trong lúc đang tải dữ liệu. |
| `stepEditor.ph.egUrl` | vd. https://... hoặc myapp://... | e.g. https://... or myapp://... | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.defaultsToApp` | mặc định dùng ứng dụng của bài kiểm thử này | defaults to this test's app | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.ph.egReferral` | vd. Referral code | e.g. Referral code | Chuỗi giao diện tĩnh (nhãn/thông báo) hiển thị cho người dùng. |
| `stepEditor.tip.accessibilityId` | Một tên ẩn mà lập trình viên đặt cho phần tử để bài kiểm thử tìm thấy nó một cách chắc chắn, kể cả khi văn bản hiển thị thay đổi. Để trống nếu bạn đang khớp theo văn bản. | A hidden name developers give an element so tests can find it reliably, even if the visible text changes. Leave blank if you're matching by text. | Một tên ẩn do lập trình viên đặt cho một phần tử giao diện, giúp bài kiểm thử tìm đúng phần tử đó dù văn bản hiển thị có thay đổi. |
| `stepEditor.tip.index` | Nếu có nhiều phần tử trên màn hình cùng văn bản, mục này chọn phần tử nào — 0 là phần tử đầu tiên, 1 là phần tử thứ hai, v.v. | If several things on screen share the same text, this picks which one — 0 is the first, 1 the second, and so on. | Số thứ tự dùng để chọn đúng phần tử khi có nhiều phần tử giống nhau trên màn hình — 0 là phần tử đầu tiên. |
| `stepEditor.tip.coord` | Vị trí chính xác trên màn hình để chạm vào, tính bằng điểm (points) từ góc trên bên trái. Dễ vỡ — nên ưu tiên “Chạm theo văn bản”. Ghi lại một lần chạm sẽ tự điền các giá trị này. | The exact spot on screen to tap, measured in points from the top-left corner. Brittle — prefer “Tap by text”. Recording a tap fills these in for you. | Vị trí chính xác trên màn hình (tính bằng điểm/points từ góc trên-trái) để chạm vào — dễ vỡ, nên ưu tiên chạm theo văn bản khi có thể. |
| `stepEditor.tip.timeout` | Thời gian tối đa để tiếp tục thử trước khi bỏ cuộc và đánh dấu bước này rớt. | How long to keep trying before giving up and failing the step. | Thời gian tối đa hệ thống chờ trước khi coi bước đó là thất bại. |
| `stepEditor.tip.raw` | Cửa ngách dành cho kỹ sư: gõ trực tiếp lệnh kiểm thử Maestro. Hầu hết bài kiểm thử không cần đến mục này. | An escape hatch for engineers: type Maestro test commands directly. Most tests never need this. | Cách viết lệnh Maestro trực tiếp — một cửa ngách dành cho kỹ sư, hầu hết bài kiểm thử không cần dùng. |
| `stepEditor.tip.launchStopBundleId` | Tên định danh riêng của ứng dụng trên iOS. Để trống để dùng ứng dụng của chính bài kiểm thử này (đặt ở phía trên). | The app's unique name in iOS. Leave blank to use this test's own app (set at the top). | Bundle id là tên định danh duy nhất của một ứng dụng trên iOS — bài kiểm thử dùng nó để biết chính xác ứng dụng nào cần chạy. |
| `stepEditor.option.customCoordinates` | tọa độ tùy chỉnh | custom coordinates | Hướng (hoặc tọa độ tùy chỉnh) của một thao tác vuốt hoặc cuộn màn hình. |
| `stepEditor.option.up` | lên | up | Hướng (hoặc tọa độ tùy chỉnh) của một thao tác vuốt hoặc cuộn màn hình. |
| `stepEditor.option.down` | xuống | down | Hướng (hoặc tọa độ tùy chỉnh) của một thao tác vuốt hoặc cuộn màn hình. |
| `stepEditor.option.left` | trái | left | Hướng (hoặc tọa độ tùy chỉnh) của một thao tác vuốt hoặc cuộn màn hình. |
| `stepEditor.option.right` | phải | right | Hướng (hoặc tọa độ tùy chỉnh) của một thao tác vuốt hoặc cuộn màn hình. |

