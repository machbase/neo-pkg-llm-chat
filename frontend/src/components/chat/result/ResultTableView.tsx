import type { TablePayload } from "../../../types/exec";

const MAX_ROWS = 1000;

export const ResultTableView = ({ data }: { data: TablePayload }) => {
    const visibleRows = data.rows.slice(0, MAX_ROWS);
    const truncatedHere = data.rows.length > MAX_ROWS;
    const showTruncatedBanner = data.truncated || truncatedHere;
    const totalRows = data.rows.length;

    return (
        <div className="chat-result-table-wrapper">
            {showTruncatedBanner && (
                <div className="chat-result-table__truncated-banner">
                    {totalRows > MAX_ROWS
                        ? `상위 ${MAX_ROWS}행만 표시 중 (전체 ${totalRows}행)`
                        : "응답이 잘렸습니다 (truncated)"}
                </div>
            )}
            <div className="chat-result-table__scroll">
                <table className="chat-result-table">
                    <thead>
                        <tr>
                            {data.columns.map((col, i) => (
                                <th key={`${col.name}-${i}`}>{col.name}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {visibleRows.map((row, ri) => (
                            <tr key={ri}>
                                {row.map((cell, ci) => (
                                    <td key={ci}>
                                        {cell === null || cell === undefined ? (
                                            <span className="chat-result-table__null">NULL</span>
                                        ) : (
                                            String(cell)
                                        )}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {data.rowsAffected !== undefined && (
                <div className="chat-result-table__affected">rowsAffected: {data.rowsAffected}</div>
            )}
        </div>
    );
};
